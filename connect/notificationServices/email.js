/**
 * Email notification service
 */
const _ = require('lodash');
const jwt = require('jsonwebtoken');
const co = require('co');
const fs = require('fs');
const path = require('path');
const { logger, busService, eventScheduler, notificationService } = require('../../index');
const { createEventScheduler, SCHEDULED_EVENT_STATUS } = eventScheduler;

const config = require('../config');
const {
  BUS_API_EVENT,
  SCHEDULED_EVENT_PERIOD,
  SETTINGS_EMAIL_SERVICE_ID,
  SETTINGS_EMAIL_BUNDLING_SERVICE_ID
} = require('../constants');
const { EVENTS, EVENT_BUNDLES } = require('../events-config');
const helpers = require('../helpers');
const service = require('../service');


function replacePlaceholders(term,data){
  let placeholders = term.match(/<[a-zA-Z]+>/g);
  let ret = term;
  if (placeholders && placeholders.length){
    _(placeholders).each(p=>{
      let values = _.map(data,p.slice(1, -1));
      const total = values.length;
      let replacement = values.length < 3 ? 
                          values.join(', ') : 
                          values.slice(0,2).join(', ') +' and ' + (total-3) +'others';
      ret = ret.replace(p, values.join(', '));
    })
  }
  return ret;
}

function getSections(projectUserEvents){
  let sections = [];
  _.chain(projectUserEvents)
  .groupBy(value => getEventGroupKey(value))
  .forIn((value,key)=>{
    if (!EVENT_BUNDLES[key].groupBy){
      sections.push({
        title:replacePlaceholders(EVENT_BUNDLES[key].title,_(value).map(g=>g.data.data).value()),
        [key]:true,
        notifications: _(value).map(v=>v.data.data).value()
      });
    } else {
      _.chain(value).groupBy(n=>n.data.data[EVENT_BUNDLES[key].groupBy]).forIn((groupValue,groupKey)=>{
        
        let title = EVENT_BUNDLES[key].title;
        title = replacePlaceholders(title,_(groupValue).map(g=>g.data.data).value());
        sections.push({
          title,
          [key]:true,
          notifications: _(groupValue).map(g=>g.data.data).value()
        });
      }).value();
    }
  }).value();


  return sections;
}

/**
 * Handles due events which are passed by scheduler
 *
 * Groups events by users, bundles them and sends using Bus API
 *
 * @param {Array}    events          due events
 * @param {Function} setEventsStatus function which sets statuses of processed events
 */
function handleScheduledEvents(events, setEventsStatus) {
  // do nothing if there are no due events
  if (events.length === 0) {
    return;
  }

  const eventsByUsers = _.groupBy(events, 'userId');

  _.values(eventsByUsers).forEach((userEvents) => {
    const bundleData = {
      subject: 'Your Topcoder project updates',
      connectURL: config.CONNECT_URL,
      projects: _.chain(userEvents)
        .groupBy('data.data.projectId')
        .mapValues(projectUserEvents => ({
          id: _.get(projectUserEvents, '[0].data.data.projectId'),
          name: _.get(projectUserEvents, '[0].data.data.projectName'),
          sections: getSections(projectUserEvents)
        }))
        .values()
        .value(),
    };

    // clone data to avoid circular object
    // we use common data from the first event
    const eventMessage = _.clone(userEvents[0].data);

    // update common values for bundled email
    eventMessage.replyTo = config.DEFAULT_REPLY_EMAIL;
    eventMessage.version="v3";
    eventMessage.cc = [];
    eventMessage.from = {
      name: config.REPLY_EMAIL_FROM,
      email: config.DEFAULT_REPLY_EMAIL,
    };

    eventMessage.data = bundleData;

    busService.postEvent({
      topic: BUS_API_EVENT.EMAIL.GENERAL,
      originator: 'tc-notifications',
      timestamp: (new Date()).toISOString(),
      'mime-type': 'application/json',
      payload: eventMessage,
    }).then(() => {
      logger.info(`Successfully sent ${BUS_API_EVENT.EMAIL.GENERAL} event`
        + ` with body ${JSON.stringify(eventMessage)} to bus api`);

      setEventsStatus(userEvents, SCHEDULED_EVENT_STATUS.COMPLETED);
    }).catch(() => {
      logger.error(`Failed to send ${BUS_API_EVENT.EMAIL.GENERAL} event`
        + ` with body ${JSON.stringify(eventMessage)} to bus api`);

      setEventsStatus(userEvents, SCHEDULED_EVENT_STATUS.FAILED);
    });
  });
}

// create and initialize scheduler
const scheduler = createEventScheduler(
  BUS_API_EVENT.EMAIL.BUNDLED,
  SCHEDULED_EVENT_PERIOD,
  handleScheduledEvents
);

function getEventGroupKey(value) {
  let key = _.chain(EVENT_BUNDLES)
    .keys()
    .find(key => _.includes(_.get(EVENT_BUNDLES, `${key}.types`), _.get(value, 'data.data.type')))
    .value();
    if (!key) return 'DEFAULT';
    return key;
}

/**
 * Prepares data to be provided to the template to render a single notification.
 *
 * @param {Object} data the notification data
 * @returns {Object}
 */
function wrapIndividualNotification(data) {
  const key = getEventGroupKey(data);
  const subject = replacePlaceholders(EVENT_BUNDLES[key].subject,[data.data.data]);

  return {
    subject,
    connectURL: config.CONNECT_URL,
    projects: [{
      id: data.data.data.projectId,
      name: data.data.data.projectName,
      sections: getSections([data]),
    }],
  };
}

/**
 * Handler function which sends notification using email
 *
 * Depend on user settings it sends email immediately
 * or bundles notifications for some period and send them together
 *
 * @param {String} topicName    topic name (event type)
 * @param {Object} messageJSON  message raw JSON
 * @param {Object} notification pre-processed notification object
 */
function handler(topicName, messageJSON, notification) {
  // if it's interesting event, create email event and send to bus api
  const notificationType = notification.newType || topicName;
  const eventType = BUS_API_EVENT.EMAIL.GENERAL;

  return co(function* () {
    const settings = yield notificationService.getSettings(notification.userId);

    // if email notification is explicitly disabled for current notification type do nothing
    // by default we treat all notification types enabled
    if (settings.notifications[notificationType]
      && settings.notifications[notificationType][SETTINGS_EMAIL_SERVICE_ID]
      && settings.notifications[notificationType][SETTINGS_EMAIL_SERVICE_ID].enabled === 'no'
    ) {
      logger.verbose(`Notification '${notificationType}' won't be sent by '${SETTINGS_EMAIL_SERVICE_ID}'`
        + ` service to the userId '${notification.userId}' due to his notification settings.`);
      return;
    }

    const users = yield service.getUsersById([notification.userId]);
    logger.debug(`got users ${JSON.stringify(users)}`);

    const user = users[0];
    let userEmail = user.email;
    if (!userEmail) {
      logger.error(`Email not received for user: ${user.id}`);
    }
    if (config.ENABLE_DEV_MODE === 'true') {
      userEmail = config.DEV_MODE_EMAIL;
    }
    const recipients = [userEmail];

    const categories = [`${config.ENV}:${eventType}`.toLowerCase()];

    const eventMessage = {
      data: {
        name: user.firstName + ' ' + user.lastName,
        handle: user.handle,
        date: (new Date()).toISOString(),
        projectName: notification.contents.projectName,
        projectId: messageJSON.projectId,
        authorHandle: notification.contents.userHandle,
        authorFullName: notification.contents.userFullName,
        photoURL: notification.contents.photoURL,
        type: notificationType,
      },
      recipients,
      version:"v3",
      from: {
        name: notification.contents.userHandle,
        email: config.DEFAULT_REPLY_EMAIL,
      },
      categories,
    };
    eventMessage.data[eventMessage.data.type]=true;
    _.assign(eventMessage.data,notification.contents);
    

    // default values that get overridden when the notification is about topics/posts updates
    let reference = 'project';
    let referenceId = eventMessage.data.projectId;

    let messagingEvent = false;
    if (_.includes(EVENT_BUNDLES.TOPICS_AND_POSTS.types, notificationType)) {
      messagingEvent = true;
      eventMessage.data.topicId = parseInt(messageJSON.topicId, 10);
      eventMessage.data.postId = messageJSON.postId ? parseInt(messageJSON.postId, 10) : null;
      if (messageJSON.postContent){
        eventMessage.data.post = helpers.markdownToHTML(messageJSON.postContent);
      }

      reference = 'topic';
      referenceId = eventMessage.data.topicId;

      if (notificationType === BUS_API_EVENT.CONNECT.POST.MENTION) {
        eventMessage.cc = [config.MENTION_EMAIL];
      }

      // get jwt token then encode it with base64
      const body = {
        userId: parseInt(notification.userId, 10),
        topicId: eventMessage.data.topicId,
        userEmail: helpers.sanitizeEmail(user.email),
      };
      logger.debug('body', body);
      logger.debug(`body for generating token: ${JSON.stringify(body)}`);
      logger.debug(`AUTH_SECRET: ${config.AUTH_SECRET.substring(-5)}`);
      const token = jwt.sign(body, config.AUTH_SECRET, { noTimestamp: true }).split('.')[2];
      logger.debug(`token: ${token}`);

      eventMessage.replyTo = `${config.REPLY_EMAIL_PREFIX}+${eventMessage.data.topicId}/${token}@`
        + config.REPLY_EMAIL_DOMAIN;
    }

    if (messageJSON.fileName) {
      eventMessage.data.fileName = messageJSON.fileName;
    }

    // if notifications has to be bundled
    let bundlingEnabled = _.get(settings, `notifications['${notificationType}'].${SETTINGS_EMAIL_BUNDLING_SERVICE_ID}.enabled`);
    let bundlePeriod = _.get(settings, `services.${SETTINGS_EMAIL_SERVICE_ID}.bundlePeriod`);
    // if bundling is not explicitly set and the event is not a messaging event, assume bundling enabled
    if (!bundlingEnabled && !messagingEvent) {
      bundlingEnabled = 'yes';
      // if bundle period is not set, assume it to be daily for default case
      bundlePeriod = !bundlePeriod ? 'daily' : bundlePeriod;
    }
    logger.debug('bundlingEnabled=>', bundlingEnabled);
    logger.debug('bundlePeriod=>', bundlePeriod);

    if (bundlingEnabled === 'yes' && bundlePeriod) {
      if (!SCHEDULED_EVENT_PERIOD[bundlePeriod]) {
        throw new Error(`User's '${notification.userId}' setting for service`
          + ` '${SETTINGS_EMAIL_SERVICE_ID}' option 'bundlePeriod' has unsupported value '${bundlePeriod}'.`);
      }

      // schedule event to be sent later
      scheduler.addEvent({
        data: eventMessage,
        period: bundlePeriod,
        userId: notification.userId,
        eventType,
        reference,
        referenceId,
      });
    } else {
      // send single field "notificationsHTML" with the rendered template
      eventMessage.data = wrapIndividualNotification({data:eventMessage});
      console.log(eventMessage.data.contents);

      // send event to bus api
      return busService.postEvent({
        topic: eventType,
        originator: 'tc-notifications',
        timestamp: (new Date()).toISOString(),
        'mime-type': 'application/json',
        payload: eventMessage,
      }).then(() => {
        logger.info(`Successfully sent ${eventType} event with body ${JSON.stringify(eventMessage)} to bus api`);
      });
    }
  });
}

module.exports = {
  handler,
};
