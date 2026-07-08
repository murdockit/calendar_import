/**
 * Gemini API integration: prompt, structured-output schema, and the HTTP call.
 */

var GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

/**
 * Extraction prompt, ported verbatim in spirit from the Node app's EXTRACTION_PROMPT.
 * The "return ONLY JSON, no markdown fences" instruction is dropped because
 * responseMimeType + responseSchema (structured output) already enforce that.
 */
function buildExtractionPrompt_() {
  var today = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd');
  return (
    'You are an assistant that extracts calendar events from flyers, posters, and event emails ' +
    '(school notices, community bulletins, camp brochures, sports schedules, etc.). ' +
    'Carefully read all text in the image/PDF or email body provided, including small print, ' +
    'and identify every distinct event being advertised.\n\n' +
    'For each event, extract:\n' +
    '- title: a short, clear name for the event\n' +
    '- date: the event date in YYYY-MM-DD format\n' +
    '- start_time: the start time in 24-hour HH:MM format, or null if no time is given\n' +
    '- end_time: the end time in 24-hour HH:MM format, or null if not given\n' +
    '- location: the venue/address, or null if not given\n' +
    '- notes: any other relevant details (cost, what to bring, registration info, age range, etc.), or null\n' +
    '- confidence: "high", "medium", or "low", reflecting how confident you are in the extracted date/time/title\n' +
    '- source_text: the exact snippet of text this event was extracted from, for auditing\n\n' +
    'Today\'s date is ' + today + '. Resolve any relative or partial dates (e.g. "this Saturday", ' +
    '"next Friday", "March 14" with no year, "every Tuesday in April") using today\'s date as the reference point. ' +
    'If a flyer lists a recurring event (e.g. "every Tuesday"), extract the discrete date instances you can determine; ' +
    'do not invent a recurrence rule.\n\n' +
    'If there are no identifiable events, return an empty array. ' +
    'If a flyer is ambiguous or low quality, still do your best and mark confidence accordingly rather than omitting the event.'
  );
}

/**
 * JSON schema for Gemini structured output: an array of event objects.
 */
function buildResponseSchema_() {
  return {
    type: 'ARRAY',
    items: {
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING' },
        date: { type: 'STRING', description: 'YYYY-MM-DD' },
        start_time: { type: 'STRING', nullable: true, description: 'HH:MM 24-hour, or null' },
        end_time: { type: 'STRING', nullable: true, description: 'HH:MM 24-hour, or null' },
        location: { type: 'STRING', nullable: true },
        notes: { type: 'STRING', nullable: true },
        confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
        source_text: { type: 'STRING', nullable: true }
      },
      required: ['title', 'date', 'confidence']
    }
  };
}

/**
 * Extraction from an image/PDF blob attachment.
 */
function callGeminiWithBlob(blob, config) {
  var parts = [
    {
      inline_data: {
        mime_type: blob.getContentType(),
        data: Utilities.base64Encode(blob.getBytes())
      }
    },
    { text: buildExtractionPrompt_() }
  ];
  return callGemini_(parts, config);
}

/**
 * Extraction from a plain-text email body (fallback when there are no usable attachments).
 */
function callGeminiWithText(bodyText, config) {
  var parts = [
    { text: buildExtractionPrompt_() + '\n\nEmail body:\n' + bodyText }
  ];
  return callGemini_(parts, config);
}

function callGemini_(parts, config) {
  var url = GEMINI_API_BASE + encodeURIComponent(config.geminiModel) + ':generateContent';
  var payload = {
    contents: [{ parts: parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: buildResponseSchema_(),
      // 2.5 models spend "thinking" tokens from the same budget, so keep it
      // roomy and disable thinking — extraction doesn't need it. Remove
      // thinkingConfig if using a model that rejects it (e.g. 2.0-era models).
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget: 0 }
    }
  };

  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': config.geminiApiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response = fetchWithRetry_(url, options);
  var code = response.getResponseCode();
  var body = response.getContentText();

  if (code === 429) {
    var quotaErr = new Error('Gemini API quota/rate limit exceeded (HTTP 429): ' + body.substring(0, 300));
    quotaErr.isQuota = true;
    throw quotaErr;
  }
  if (code !== 200) {
    throw new Error('Gemini API returned HTTP ' + code + ': ' + body.substring(0, 500));
  }

  var json;
  try {
    json = JSON.parse(body);
  } catch (err) {
    throw new Error('Gemini API returned unparseable response envelope.');
  }

  if (json.promptFeedback && json.promptFeedback.blockReason) {
    throw new Error('Gemini blocked the request: ' + json.promptFeedback.blockReason);
  }

  if (!json.candidates || json.candidates.length === 0) {
    throw new Error('Gemini returned no candidates.');
  }

  var candidate = json.candidates[0];
  if (candidate.finishReason === 'SAFETY') {
    throw new Error('Gemini blocked the response for safety reasons.');
  }
  if (candidate.finishReason === 'MAX_TOKENS') {
    throw new Error('Gemini output was truncated (MAX_TOKENS). Consider raising maxOutputTokens.');
  }

  var text;
  try {
    text = candidate.content.parts[0].text;
  } catch (err) {
    throw new Error('Gemini response was missing expected content/parts/text.');
  }

  var events;
  try {
    events = JSON.parse(text);
  } catch (err) {
    throw new Error('Gemini returned output that could not be parsed as JSON: ' + text.substring(0, 300));
  }

  if (!Array.isArray(events)) {
    throw new Error('Gemini returned JSON that was not an array.');
  }

  return events;
}

/**
 * Fetch with a single retry (with backoff) on 5xx. 429s are not retried here —
 * they mean quota exhaustion, which pauses the whole run until the next cycle.
 */
function fetchWithRetry_(url, options) {
  var response = UrlFetchApp.fetch(url, options);
  if (response.getResponseCode() >= 500) {
    Utilities.sleep(2000);
    response = UrlFetchApp.fetch(url, options);
  }
  return response;
}
