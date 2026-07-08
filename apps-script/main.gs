/**
 * Gmail -> Shared Google Calendar Flyer Extractor
 * Entry point: processFlyerInbox() (run on a time-driven trigger via installTrigger()).
 */

// Edit this to match the timeZone set in appsscript.json.
var TIMEZONE = 'America/New_York';

var LABEL_INPUT = 'flyers';
var LABEL_PROCESSED = 'flyers-processed';
var LABEL_FAILED = 'flyers-failed';

var MAX_ATTEMPT_COUNTER_PREFIX = 'attempts_';
var MAX_ATTEMPTS = 3;

var SUPPORTED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf'
];

var MIN_ATTACHMENT_BYTES = 20 * 1024; // 20 KB - skip tiny inline signature images/logos
var MAX_ATTACHMENT_BYTES = 7 * 1024 * 1024; // ~7 MB raw, conservative vs Gemini's ~20MB request cap

function getConfig_() {
  var props = PropertiesService.getScriptProperties();
  var calendarId = props.getProperty('CALENDAR_ID');
  if (!calendarId) {
    throw new Error('CALENDAR_ID script property is not set. Set it before running processFlyerInbox().');
  }
  var geminiApiKey = props.getProperty('GEMINI_API_KEY');
  if (!geminiApiKey) {
    throw new Error('GEMINI_API_KEY script property is not set. Set it before running processFlyerInbox().');
  }
  var calendarMap = {};
  var calendarMapRaw = props.getProperty('CALENDAR_MAP');
  if (calendarMapRaw) {
    try {
      calendarMap = JSON.parse(calendarMapRaw);
    } catch (err) {
      throw new Error('CALENDAR_MAP script property is not valid JSON: ' + err.message);
    }
  }
  return {
    calendarId: calendarId,
    calendarMap: calendarMap,
    geminiApiKey: geminiApiKey,
    geminiModel: props.getProperty('GEMINI_MODEL') || 'gemini-2.5-flash',
    gmailQuery: props.getProperty('GMAIL_QUERY') || ('label:' + LABEL_INPUT + ' -label:' + LABEL_PROCESSED + ' -label:' + LABEL_FAILED),
    maxMessagesPerRun: Number(props.getProperty('MAX_MESSAGES_PER_RUN')) || 5,
    summaryEmail: props.getProperty('SUMMARY_EMAIL') || Session.getActiveUser().getEmail()
  };
}

/**
 * Creates (or replaces) the 15-minute time-driven trigger for processFlyerInbox.
 * Run this once manually from the Apps Script editor.
 */
function installTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'processFlyerInbox') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('processFlyerInbox')
    .timeBased()
    .everyMinutes(15)
    .create();
  Logger.log('Installed 15-minute trigger for processFlyerInbox.');
}

/**
 * Main entry point, called by the time-driven trigger.
 */
function processFlyerInbox() {
  // Prevent a manual run overlapping the timed trigger (double-created events).
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    Logger.log('Another run is in progress; skipping.');
    return;
  }
  try {
    processFlyerInboxLocked_();
  } finally {
    lock.releaseLock();
  }
}

function processFlyerInboxLocked_() {
  var config = getConfig_();
  ensureLabelsExist_();

  var threads = GmailApp.search(config.gmailQuery, 0, config.maxMessagesPerRun);
  if (!threads || threads.length === 0) {
    return;
  }

  var results = {
    created: [],
    duplicates: [],
    lowConfidence: [],
    errors: []
  };

  var processedCount = 0;
  var quotaExhausted = false;
  for (var t = 0; t < threads.length && processedCount < config.maxMessagesPerRun && !quotaExhausted; t++) {
    var thread = threads[t];
    var messages = thread.getMessages();
    for (var m = 0; m < messages.length && processedCount < config.maxMessagesPerRun; m++) {
      var message = messages[m];
      if (messageHasLabel_(thread, LABEL_PROCESSED) || messageHasLabel_(thread, LABEL_FAILED)) {
        continue;
      }
      processedCount++;
      var msgId = message.getId();
      try {
        var outcome = processMessage_(message, config, results);
        if (outcome.hardFailure) {
          // Extraction wholly failed: leave the "flyers" label so it retries,
          // and give up (flyers-failed) after MAX_ATTEMPTS.
          recordFailedAttempt_(thread, msgId, results, message.getSubject(), outcome.error);
        } else {
          applyLabel_(thread, LABEL_PROCESSED);
          message.markRead();
          clearAttemptCounter_(msgId);
        }
      } catch (err) {
        if (err && err.isQuota) {
          // API quota is exhausted: every remaining message would fail too.
          // Stop the run without penalizing this message; it retries next run.
          quotaExhausted = true;
          results.errors.push({
            subject: message.getSubject(),
            error: 'Run paused: ' + err.message + ' — unprocessed messages will retry on the next run.'
          });
          break;
        }
        recordFailedAttempt_(thread, msgId, results, message.getSubject(), String(err && err.message ? err.message : err));
      }
    }
  }

  if (results.created.length || results.duplicates.length || results.errors.length) {
    sendSummaryEmail(config.summaryEmail, results);
  }
}

function messageHasLabel_(thread, labelName) {
  var labels = thread.getLabels();
  for (var i = 0; i < labels.length; i++) {
    if (labels[i].getName() === labelName) return true;
  }
  return false;
}

function applyLabel_(thread, labelName) {
  var label = GmailApp.getUserLabelByName(labelName);
  if (!label) label = GmailApp.createLabel(labelName);
  thread.addLabel(label);
}

function ensureLabelsExist_() {
  [LABEL_INPUT, LABEL_PROCESSED, LABEL_FAILED].forEach(function (name) {
    if (!GmailApp.getUserLabelByName(name)) {
      GmailApp.createLabel(name);
    }
  });
}

function recordFailedAttempt_(thread, msgId, results, subject, errorText) {
  var attempts = incrementAttemptCounter_(msgId);
  results.errors.push({
    subject: subject,
    error: errorText + ' (attempt ' + attempts + ' of ' + MAX_ATTEMPTS + ')'
  });
  if (attempts >= MAX_ATTEMPTS) {
    applyLabel_(thread, LABEL_FAILED);
    clearAttemptCounter_(msgId);
  }
}

function incrementAttemptCounter_(messageId) {
  var props = PropertiesService.getScriptProperties();
  var key = MAX_ATTEMPT_COUNTER_PREFIX + messageId;
  var attempts = Number(props.getProperty(key) || '0') + 1;
  props.setProperty(key, String(attempts));
  return attempts;
}

function clearAttemptCounter_(messageId) {
  PropertiesService.getScriptProperties().deleteProperty(MAX_ATTEMPT_COUNTER_PREFIX + messageId);
}

/**
 * Extracts events from a single Gmail message (via attachments or text fallback),
 * creates calendar events, and records outcomes into `results`.
 *
 * Returns { hardFailure, error }: hardFailure is true when extraction wholly
 * failed (no events AND at least one extraction error), so the caller leaves
 * the message unprocessed for retry. Quota errors are rethrown so the caller
 * can pause the whole run.
 */
function processMessage_(message, config, results) {
  var subject = message.getSubject();
  var attachments = collectUsableAttachments_(message, results, subject);

  var events = [];
  var extractionErrors = [];
  if (attachments.length > 0) {
    for (var i = 0; i < attachments.length; i++) {
      var blob = attachments[i];
      try {
        var extracted = callGeminiWithBlob(blob, config);
        events = events.concat(extracted);
      } catch (err) {
        if (err && err.isQuota) throw err;
        extractionErrors.push('Gemini extraction failed for attachment "' + blob.getName() + '": ' + (err && err.message ? err.message : err));
      }
    }
  } else {
    var body = message.getPlainBody();
    if (!body || !body.trim()) {
      return { hardFailure: false }; // nothing to extract from
    }
    try {
      events = callGeminiWithText(body, config);
    } catch (err) {
      if (err && err.isQuota) throw err;
      extractionErrors.push('Gemini extraction failed for message body: ' + (err && err.message ? err.message : err));
    }
  }

  if (events.length === 0 && extractionErrors.length > 0) {
    return { hardFailure: true, error: extractionErrors.join('; ') };
  }

  // Partial failures (some attachments extracted, some didn't) still count as
  // processed — report the failures in the summary but don't retry the message,
  // which would duplicate the successful extractions' events on every retry.
  extractionErrors.forEach(function (e) {
    results.errors.push({ subject: subject, error: e });
  });

  for (var e = 0; e < events.length; e++) {
    createEventFromExtraction(events[e], { subject: subject }, config, results);
  }
  return { hardFailure: false };
}

function collectUsableAttachments_(message, results, subject) {
  var out = [];
  // Include inline images: phone forwards often embed the flyer photo in the
  // body rather than attaching it. The size floor below filters signature logos.
  var attachments = message.getAttachments({ includeInlineImages: true, includeAttachments: true });
  for (var i = 0; i < attachments.length; i++) {
    var blob = attachments[i];
    var contentType = blob.getContentType();
    if (SUPPORTED_MIME_TYPES.indexOf(contentType) === -1) continue;
    var size = blob.getBytes().length;
    if (size < MIN_ATTACHMENT_BYTES) continue; // likely a signature logo
    if (size > MAX_ATTACHMENT_BYTES) {
      results.errors.push({
        subject: subject,
        error: 'Skipped attachment "' + blob.getName() + '" (' + Math.round(size / 1024 / 1024) + ' MB): exceeds size cap.'
      });
      continue;
    }
    out.push(blob);
  }
  return out;
}
