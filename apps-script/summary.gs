/**
 * Builds and sends the after-the-fact review email summarizing a run.
 */

function sendSummaryEmail(toEmail, results) {
  var subject = 'Flyer Calendar: ' + results.created.length + ' created, ' +
    results.duplicates.length + ' skipped, ' + results.errors.length + ' errors';

  var body = buildSummaryEmail(results);
  MailApp.sendEmail(toEmail, subject, body);
}

function buildSummaryEmail(results) {
  var lines = [];

  lines.push('Flyer Calendar Extractor — run summary');
  lines.push('');

  lines.push('Events created (' + results.created.length + '):');
  if (results.created.length === 0) {
    lines.push('  (none)');
  } else {
    results.created.forEach(function (e) {
      var when = e.date + (e.start_time ? ' ' + e.start_time : ' (all day)');
      lines.push('  - ' + e.title + ' — ' + when + (e.location ? ' @ ' + e.location : ''));
    });
  }
  lines.push('');

  lines.push('Skipped as duplicates (' + results.duplicates.length + '):');
  if (results.duplicates.length === 0) {
    lines.push('  (none)');
  } else {
    results.duplicates.forEach(function (e) {
      lines.push('  - ' + e.title + ' — ' + e.date);
    });
  }
  lines.push('');

  lines.push('Low-confidence events to double-check (' + results.lowConfidence.length + '):');
  if (results.lowConfidence.length === 0) {
    lines.push('  (none)');
  } else {
    results.lowConfidence.forEach(function (e) {
      lines.push('  ⚑ ' + e.title + ' — ' + e.date);
    });
  }
  lines.push('');

  lines.push('Errors (' + results.errors.length + '):');
  if (results.errors.length === 0) {
    lines.push('  (none)');
  } else {
    results.errors.forEach(function (e) {
      lines.push('  - [' + e.subject + '] ' + e.error);
    });
  }

  return lines.join('\n');
}
