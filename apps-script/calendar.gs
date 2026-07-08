/**
 * Calendar event creation, duplicate detection, and validation.
 */

var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
var TIME_RE = /^\d{2}:\d{2}$/;

/**
 * Validates one extracted event, creates it (with a duplicate check) on the
 * shared calendar, and records the outcome (created/duplicate/invalid) into `results`.
 */
function createEventFromExtraction(event, meta, config, results) {
  var subject = meta.subject;

  if (!event || typeof event.title !== 'string' || !event.title.trim()) {
    results.errors.push({ subject: subject, error: 'Extracted event missing a title; skipped.' });
    return;
  }
  if (!event.date || !DATE_RE.test(event.date)) {
    results.errors.push({ subject: subject, error: 'Extracted event "' + event.title + '" has an invalid date ("' + event.date + '"); skipped.' });
    return;
  }
  if (event.start_time && !TIME_RE.test(event.start_time)) {
    results.errors.push({ subject: subject, error: 'Extracted event "' + event.title + '" has an invalid start_time ("' + event.start_time + '"); skipped.' });
    return;
  }
  if (event.end_time && !TIME_RE.test(event.end_time)) {
    event.end_time = null; // don't fail the whole event over a malformed end time
  }

  var calendarId = meta.calendarId || config.calendarId;
  var calendar = CalendarApp.getCalendarById(calendarId);
  if (!calendar) {
    throw new Error('Could not open calendar with ID "' + calendarId + '". Check the CALENDAR_ID/CALENDAR_MAP script properties.');
  }

  var dayDate = parseDateInTimeZone_(event.date);

  if (isDuplicate_(calendar, dayDate, event.title)) {
    results.duplicates.push({ title: event.title, date: event.date, calendar: calendar.getName() });
    return;
  }

  var description = buildDescription_(event, subject);

  if (event.start_time) {
    var start = parseDateTimeInTimeZone_(event.date, event.start_time);
    var end;
    if (event.end_time) {
      end = parseDateTimeInTimeZone_(event.date, event.end_time);
      if (end <= start) {
        end = new Date(start.getTime() + 60 * 60 * 1000);
      }
    } else {
      end = new Date(start.getTime() + 60 * 60 * 1000);
    }
    calendar.createEvent(event.title, start, end, {
      location: event.location || '',
      description: description
    });
    results.created.push({ title: event.title, date: event.date, start_time: event.start_time, location: event.location, calendar: calendar.getName() });
  } else {
    calendar.createAllDayEvent(event.title, dayDate, {
      location: event.location || '',
      description: description
    });
    results.created.push({ title: event.title, date: event.date, start_time: null, location: event.location, calendar: calendar.getName() });
  }

  if (event.confidence === 'low') {
    results.lowConfidence.push({ title: event.title, date: event.date });
  }
}

/**
 * Picks the target calendar for a message based on its subject line.
 *
 * Looks for bracket tags first (e.g. "Fwd: [Chloe] Soccer schedule" matches
 * alias "chloe" in CALENDAR_MAP), then falls back to a plain substring match
 * of any alias name in the subject, then to the default CALENDAR_ID.
 * Map keys are pre-normalized to lowercase in getConfig_().
 *
 * Returns { calendarId, matchedAlias, warning } — warning is set when the
 * subject carries a bracket tag that routed nowhere, so the summary email can
 * surface misconfigured tags instead of silently using the default calendar.
 */
function resolveCalendarRouting_(subject, config) {
  var map = config.calendarMap || {};
  var aliases = Object.keys(map);
  var subjectLower = (subject || '').toLowerCase();

  // Check every bracket tag in the subject (forwards often carry extra tags
  // like "[EXTERNAL]"), not just the first one.
  var tags = [];
  var re = /\[([^\]]+)\]/g;
  var m;
  while ((m = re.exec(subjectLower)) !== null) {
    tags.push(m[1].trim());
  }
  for (var i = 0; i < tags.length; i++) {
    if (map[tags[i]]) {
      return { calendarId: map[tags[i]], matchedAlias: tags[i] };
    }
  }

  for (var a = 0; a < aliases.length; a++) {
    if (subjectLower.indexOf(aliases[a]) !== -1) {
      return { calendarId: map[aliases[a]], matchedAlias: aliases[a] };
    }
  }

  var result = { calendarId: config.calendarId, matchedAlias: null };
  if (tags.length > 0) {
    if (aliases.length === 0) {
      result.warning = 'Subject tag [' + tags[0] + '] found but CALENDAR_MAP is empty or unset — events went to the default calendar. ' +
        'Check the CALENDAR_MAP script property and make sure the latest main.gs is deployed.';
    } else {
      result.warning = 'Subject tag [' + tags.join('], [') + '] matched no CALENDAR_MAP alias (known: ' + aliases.join(', ') + ') — events went to the default calendar.';
    }
  }
  return result;
}

function isDuplicate_(calendar, dayDate, title) {
  var existing = calendar.getEventsForDay(dayDate);
  var normalizedTitle = title.trim().toLowerCase();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getTitle().trim().toLowerCase() === normalizedTitle) {
      return true;
    }
  }
  return false;
}

function buildDescription_(event, subject) {
  var lines = [];
  if (event.notes) lines.push(event.notes);
  lines.push('');
  lines.push('— extracted from email "' + subject + '" · confidence: ' + (event.confidence || 'unknown'));
  if (event.source_text) lines.push(event.source_text);
  return lines.join('\n');
}

function parseDateInTimeZone_(dateStr) {
  return Utilities.parseDate(dateStr + ' 00:00:00', TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
}

function parseDateTimeInTimeZone_(dateStr, timeStr) {
  return Utilities.parseDate(dateStr + ' ' + timeStr + ':00', TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
}
