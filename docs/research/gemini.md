# Research notes: Google Gemini API (ai.google.dev) as of 2026-09-24: model IDs, pricing, generateContent and Interactions REST fields, audio limits and data-use terms

_Collected 2026-09-24 via web research (single pass, not yet re-verified). Sources are linked per fact. The build container itself cannot reach these hosts._

## Corrections and surprises

- Both model IDs from the brief exist: gemini-3.5-flash-lite (stable, July 21, 2026) and gemini-3.5-transcribe (Aug 26, 2026). Newer generalist models also exist: gemini-3.6-flash, 3.7-flash and 3.8-flash (GA). Google's recommended pair for new projects is '3.5 Flash-Lite or 3.8 Flash'.
- Google now labels generateContent 'legacy' and recommends the Interactions API (POST /v1beta/interactions, snake_case fields, GA June 2026). generateContent is still fully supported.
- Through generateContent, gemini-3.5-transcribe returns the transcript in parts[].audioTranscription.text, not parts[].text. Code that reads only candidates[0].content.parts[0].text gets an empty string. Smart mode reportedly returns an empty transcript on generateContent, so use Interactions for it.
- The Interactions API stores every request and response server-side by default: store=true, 55 days on paid, 1 day on free. Send store:false for private data.
- gemini-3.5-flash-lite costs more for text than gemini-3.1-flash-lite ($0.30/$2.50 vs $0.25/$1.50). 3.5 Flash-Lite drops the separate audio surcharge ($0.30 vs 3.1's $0.50 for audio), so it is cheaper for audio input only.
- gemini-2.5-flash-lite and the other 2.5 models return 404 'no longer available to new users'. The 2.0 models shut down June 1, 2026.
- The Developer API audio MIME list includes audio/webm and audio/m4a but not audio/mp4, the default from iPhone Safari's MediaRecorder. Vertex and Firebase list audio/mp4. This is not verified for the Developer API.
- The docs disagree on inline size: 20 MB on the audio page and Firebase, 100 MB on the newer file-input-methods page.
- Audio tokenization is inconsistent: 32 tokens per second in the audio and tokens docs, 25 tokens per second in the transcribe pricing estimate.
- Forum reports (Aug–Sep 2026) describe gemini-3.5-transcribe returning HTTP 200 with zero output tokens on REST paths. Another reports Tier 2 enforcing 100 RPD while AI Studio shows 10,000 RPD. Handle empty transcripts and retry.
- The SDK types mark responseMimeType and responseSchema as deprecated in favour of responseFormat, but also say ResponseFormat is 'not supported in Gemini API'. Keep using responseMimeType with responseSchema or responseJsonSchema on the Developer API's generateContent.
- Gemini 3.x Flash and Flash-Lite cannot fully disable thinking; 'minimal' is the lowest level, and 3.8 Flash does not support minimal. Sending thinkingBudget and thinkingLevel together returns a 400 error.
- I could not fetch the official docs directly because the egress proxy blocked ai.google.dev. Pricing and status facts come from search-engine snippets and should be checked on the pricing page before hard-coding.

## Facts

### Method note: I could not open the official docs directly. The egress proxy blocked WebFetch for ai.google.dev, docs.cloud.google.com, blog.google and aistudio.google.com. Facts about ai.google.dev pages come from search-engine snippets of those pages. Field names were checked in the official @google/genai 2.24.0 SDK type definitions, downloaded from npm. Real API behaviour was checked with code search in the official google-gemini GitHub org.

SDK: npm @google/genai@2.24.0 (published 2026-09-22), file dist/genai.d.ts. GitHub repos searched: google-gemini/jot-gemini-transcribe-macOS, google-gemini/gemini-skills, google-gemini/cookbook. Facts from search snippets are marked secondary-source. Facts confirmed in the SDK types are marked verified-official-doc.

Source: https://registry.npmjs.org/@google/genai/-/genai-2.24.0.tgz · confidence: verified-official-doc

### The model ID gemini-3.5-flash-lite exists. It is a stable, generally available (GA) model released July 21, 2026, and Google recommends it for new projects alongside 3.8 Flash. **(load-bearing)**

Model code: "gemini-3.5-flash-lite". Changelog, July 21 2026: 'stable, production-ready versions … Gemini 3.6 Flash (gemini-3.6-flash) … and Gemini 3.5 Flash-Lite (gemini-3.5-flash-lite)'. Models page: 'For any new projects, use the latest models: 3.5 Flash-Lite or 3.8 Flash.' The official cookbook uses it (OUTPUT_JUDGE_MODEL = "gemini-3.5-flash-lite" in tools/nb_tester/config.py). Limits per secondary sources: 1,048,576 input tokens and 65,536 output tokens. Inputs: text, image, video, audio, PDF.

Source: https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite · confidence: secondary-source

### The model ID gemini-3.5-transcribe exists. It is Google's dedicated speech-to-text model for pre-recorded audio (not streaming). A separate model, gemini-3.5-transcribe-live, handles streaming over the Live API WebSocket. **(load-bearing)**

Announced August 26, 2026. Model page: 'Gemini 3.5 Transcribe (gemini-3.5-transcribe) is a high-accuracy, low-latency non-streaming speech-to-text model with utterance-based language detection across 85+ languages, speaker diarization, word-level timestamps, and custom vocabulary biasing (up to 1,000 terms)'. The live model uses wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent. Google's migration table (gemini-skills) maps 'Legacy audio understanding / ASR' to `gemini-3.5-transcribe`. Status is unclear: one ai.google.dev snippet says GA, while press coverage says 'public preview as of August 26, 2026'. Vertex/Agent Platform uses the ID gemini-3.5-transcribe-preview.

Source: https://ai.google.dev/gemini-api/docs/models/gemini-3.5-transcribe · confidence: secondary-source

### Other current model IDs, stable and preview (from the SDK's model type and the docs).

Stable: gemini-3.8-flash (GA), gemini-3.7-flash, gemini-3.6-flash, gemini-3.5-flash, gemini-3.5-flash-lite, gemini-3.1-flash-lite, gemini-3.1-flash-image, gemini-3-pro-image, gemini-3.8-flash-tts, gemini-3.8-flash-lite-tts, gemini-3.8-live, gemini-3.8-live-extended-thinking. Aliases: gemini-flash-latest, gemini-flash-lite-latest, gemini-pro-latest. Preview: gemini-3.1-pro-preview, gemini-3.1-pro-preview-customtools, gemini-3-flash-preview, gemini-3.1-flash-tts-preview, gemini-3.5-live-translate-preview, nano-banana-pro-preview, lyria-3-clip-preview, lyria-3-pro-preview. The SDK's model list (Model_2 in genai.d.ts) does not yet include gemini-3.5-flash-lite or gemini-3.5-transcribe, but it accepts any string.

Source: https://ai.google.dev/gemini-api/docs/models · confidence: verified-official-doc

### The 2.0 models are shut down, and the 2.5 models are closed to new users. Do not target gemini-2.5-flash-lite. **(load-bearing)**

gemini-2.0-flash and gemini-2.0-flash-lite shut down June 1, 2026. New keys calling 2.5 models get 404 'This model models/gemini-2.5-flash-lite is no longer available to new users.' Forum threads cite an official shutdown date of Oct 16, 2026 for the 2.5 models. gemini-3.1-flash-lite-preview was shut down May 25, 2026 (use gemini-3.1-flash-lite).

Source: https://ai.google.dev/gemini-api/docs/deprecations · confidence: secondary-source

### Paid-tier price for gemini-3.5-flash-lite: $0.30 per 1M input tokens (one rate for text, image, video and audio) and $2.50 per 1M output tokens, with thinking tokens billed as output. Batch mode is half price. **(load-bearing)**

Standard: input $0.30/1M (text/image/video/audio), output $2.50/1M including thinking. Batch: $0.15 / $1.25. TokenCost: '3.5 Flash-Lite drops the separate audio line entirely, with the pricing page now reading $0.30 for text, image, video and audio together.' One search summary said $0.50 for audio, which is 3.1 Flash-Lite's rate, so treat it as a mix-up. Please check the exact row on the pricing page.

Source: https://ai.google.dev/gemini-api/docs/pricing · confidence: secondary-source

### gemini-3.1-flash-lite is the cheapest current stable model for text-only work at $0.25 in / $1.50 out per 1M tokens. For audio input it costs $0.50 per 1M, so gemini-3.5-flash-lite ($0.30) is cheaper for audio. **(load-bearing)**

3.1 Flash-Lite: input $0.25/1M (text/image/video), audio input $0.50/1M, cached audio $0.05, output $1.50/1M. Its default thinking level is 'minimal'. No deprecation has been announced, but Google's migration table recommends moving 2.5-flash-lite and 3.1-flash-lite to gemini-3.5-flash-lite. Other reference prices: gemini-3.6-flash $1.50/$7.50; gemini-3.8-flash introductory $0.75/$3.75 through Dec 31, 2026, then $1.50/$7.50 from Jan 1, 2027.

Source: https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite · confidence: secondary-source

### Paid-tier price for gemini-3.5-transcribe: $2.00 per 1M audio input tokens (about $0.003/min) and $12.00 per 1M text output tokens (about $0.002/min), or roughly $0.005 per minute combined. The live model costs $3.50 / $21.00 per 1M tokens (about $0.009 per minute). Billing is per token, not per request. **(load-bearing)**

Pricing page: 'Input price $2.00 per 1M tokens or $0.003/min (audio); Output price $12.00 per 1M tokens or $0.002/min (text). Estimated pricing is based on 25 audio tokens per second for input and 175 text tokens per minute for output, for an effective blended rate of ~$0.005 per min.' gemini-3.5-transcribe-live: $3.50 / $21.00 per 1M tokens, ~$0.009/min.

Source: https://ai.google.dev/gemini-api/docs/pricing · confidence: secondary-source

### The generateContent REST endpoint and API-key header are unchanged. **(load-bearing)**

curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent" -H "x-goog-api-key: $GEMINI_API_KEY" -H 'Content-Type: application/json' -X POST -d '{"contents":[{"parts":[{"text":"..."}]}],"generationConfig":{...}}'. The streaming variant is :streamGenerateContent?alt=sse. Google's Jot app uses the x-goog-api-key header and avoids ?key= so the key does not leak into logs.

Source: https://ai.google.dev/gemini-api/docs/structured-output · confidence: verified-official-doc

### Google now labels generateContent as 'legacy', and the Interactions API (GA June 2026) is the recommended API for new projects. generateContent is not deprecated and remains fully supported. **(load-bearing)**

Doc sections are now titled 'Gemini Generate Content API (Legacy)' under /gemini-api/docs/generate-content/*. Docs: 'While generateContent remains fully supported, we recommend the Interactions API for all new development.' Interactions endpoint: POST https://generativelanguage.googleapis.com/v1beta/interactions. Error shapes differ: Interactions returns error.code as a string ("not_found"), generateContent as an integer.

Source: https://ai.google.dev/gemini-api/docs/migrate-to-interactions · confidence: secondary-source

### These generationConfig fields exist for generateContent (camelCase in REST JSON). **(load-bearing)**

generationConfig: maxOutputTokens (int), temperature, topP, topK, seed, stopSequences, candidateCount, responseMimeType ('text/plain' default | 'application/json'), responseSchema (OpenAPI 3.0 subset; requires responseMimeType application/json), responseJsonSchema (JSON Schema; 'If set, response_schema must be omitted, but response_mime_type is required'; supports $id,$defs,$ref,$anchor,type,format,title,description,enum,items,prefixItems,minItems,maxItems,minimum,maximum,anyOf,oneOf,properties,additionalProperties,required,propertyOrdering), thinkingConfig, audioTranscriptionConfig, audioTimestamp, mediaResolution. The SDK marks responseMimeType and responseSchema 'Deprecated: Use response_format instead', but ResponseFormat is documented as 'not supported in Gemini API' (Vertex-only), so keep using responseMimeType with responseSchema or responseJsonSchema on the Developer API.

Source: https://registry.npmjs.org/@google/genai/-/genai-2.24.0.tgz · confidence: verified-official-doc

### thinkingConfig accepts either thinkingLevel (for Gemini 3.x) or the legacy thinkingBudget. Sending both in one request returns HTTP 400. **(load-bearing)**

thinkingConfig: { includeThoughts?: bool, thinkingBudget?: int (0 = disabled, -1 = automatic; legacy), thinkingLevel?: 'MINIMAL'|'LOW'|'MEDIUM'|'HIGH' }. Docs: 'You cannot use both thinking_level and the legacy thinking_budget parameter in the same request. Doing so will return a 400 error.' Flash and Flash-Lite 3.x models cannot turn thinking fully off; MINIMAL is the lowest level. 3.1 Flash-Lite defaults to minimal; 3.5 Flash defaults to medium; 3.1 Pro defaults to high. 3.8 Flash does not support minimal. I could not confirm the default level for 3.5 Flash-Lite.

Source: https://ai.google.dev/gemini-api/docs/generate-content/thinking · confidence: verified-official-doc

### Thinking tokens are billed at the output rate, and usageMetadata reports them separately. Whether maxOutputTokens caps thinking plus answer is not documented. **(load-bearing)**

Docs: 'When you turn on thinking, response pricing is the sum of output tokens and thinking tokens … pricing is based on the full thought tokens.' Open forum questions (Sep 2026) ask whether maxOutputTokens bounds thoughtsTokenCount + candidatesTokenCount on 3.5 Flash-Lite and 3.8 Flash; no official answer. Watch finishReason MAX_TOKENS.

Source: https://ai.google.dev/gemini-api/docs/tokens · confidence: secondary-source

### usageMetadata field names in generateContent responses. **(load-bearing)**

usageMetadata: promptTokenCount, candidatesTokenCount, thoughtsTokenCount, totalTokenCount (= prompt + candidates + toolUsePrompt + thoughts), cachedContentTokenCount, toolUsePromptTokenCount, promptTokensDetails[], candidatesTokensDetails[], cacheTokensDetails[], toolUsePromptTokensDetails[]. Each details entry is {modality, tokenCount}, where modality is one of MODALITY_UNSPECIFIED | TEXT | IMAGE | VIDEO | AUDIO | DOCUMENT. Example: promptTokensDetails: [{"modality":"AUDIO","tokenCount":1920},{"modality":"TEXT","tokenCount":12}].

Source: https://registry.npmjs.org/@google/genai/-/genai-2.24.0.tgz · confidence: verified-official-doc

### Request and response shape for the Interactions API. Field names are snake_case. **(load-bearing)**

POST /v1beta/interactions body: { model, input: [{type:'audio', mime_type:'audio/webm', data:'<base64>'} | {type:'audio', uri:'<files uri>', mime_type}], system_instruction?: string, generation_config?: { max_output_tokens, thinking_level: 'minimal'|'low'|'medium'|'high', thinking_summaries, stop_sequences, seed, transcription_config: { language_codes: string[], custom_vocabulary: string[], mode: 'verbatim'|'smart' } }, response_format?: {type:'text', mime_type:'application/json', schema:{...}}, store?: bool, stream?: bool }. Response: { id, status:'completed', steps:[{type:'model_output', content:[{type:'text', text:'...'}]}], usage:{ total_input_tokens, total_output_tokens, total_thought_tokens, total_tokens, input_tokens_by_modality[], output_tokens_by_modality[] } }. Google's Jot test fixture shows this steps/model_output/text shape. SDK convenience field: output_text.

Source: https://registry.npmjs.org/@google/genai/-/genai-2.24.0.tgz · confidence: verified-official-doc

### By default the Interactions API stores every interaction server-side: 55 days on the paid tier, 1 day on the free tier. Set store:false to opt out. **(load-bearing)**

Docs: 'By default, the API stores all Interaction objects (store=true)'. Retention is 55 days on paid and 1 day on free. store=false cannot be combined with background execution or previous_interaction_id. Paid projects can set retention to 7, 14, 28 or 55 days in AI Studio. For a private dashboard, send store:false.

Source: https://ai.google.dev/gemini-api/docs/interactions-overview · confidence: secondary-source

### gemini-3.5-transcribe also works through generateContent, using generationConfig.audioTranscriptionConfig. The transcript comes back in a dedicated parts[].audioTranscription object, not in parts[].text. **(load-bearing)**

generationConfig.audioTranscriptionConfig: { languageCodes?: string[], customVocabulary?: string[], wordTimestamp?: bool, diarization?: bool, mode?: 'VERBATIM'|'SMART' } (SMART cannot be combined with timestamps or diarization). Response Part field audioTranscription: { text, finished, languageCode, speakerLabel ('spk_1'…), words[] }. Google's Jot app calls v1beta/models/gemini-3.5-transcribe:generateContent with inline_data audio/flac. A third-party issue (CLIProxyAPI #5722) confirms the transcript arrives in the audioTranscription part, so read parts[].audioTranscription.text before parts[].text. Jot's SettingsStore says smart formatting is unavailable on the legacy endpoint ('mode' returns an empty transcript). Use the Interactions API for smart mode.

Source: https://github.com/google-gemini/jot-gemini-transcribe-macOS · confidence: secondary-source

### The Interactions API lists these audio MIME types. audio/webm is included; audio/mp4 is not. **(load-bearing)**

AudioContentMimeType = "audio/wav" | "audio/mp3" | "audio/aiff" | "audio/aac" | "audio/ogg" | "audio/flac" | "audio/mpeg" | "audio/m4a" | "audio/l16" | "audio/opus" | "audio/alaw" | "audio/mulaw" | "audio/webm". The ai.google.dev audio page carries the same list. Firebase AI Logic and Vertex list audio/x-aac, audio/flac, audio/mp3, audio/m4a, audio/mpeg, audio/mpga, audio/mp4, audio/ogg, audio/pcm, audio/wav, audio/webm.

Source: https://ai.google.dev/gemini-api/docs/audio · confidence: verified-official-doc

### iPhone Safari's MediaRecorder produces audio/mp4 (AAC), which is not on the Developer API list. I could not confirm whether the API accepts audio/mp4. Relabelling the recording as audio/m4a or audio/aac is a guess. **(load-bearing)**

WebKit: Safari 14.5+ on iOS records audio/mp4 (AAC). Safari 18.4 added WebM, Ogg and fragmented MP4. Use MediaRecorder.isTypeSupported('audio/webm;codecs=opus') first and fall back to audio/mp4. Before shipping, test audio/mp4 against gemini-3.5-transcribe and gemini-3.5-flash-lite, and test with 'audio/m4a' as a fallback label.

Source: https://webkit.org/blog/11353/mediarecorder-api/ · confidence: unverified

### Label WebM uploads explicitly as audio/webm. Audio labelled video/webm returns HTTP 200 with an empty transcript and zero audio tokens. **(load-bearing)**

LiteLLM issue #38963: 'gemini-3.5-transcribe-preview on Vertex AI silently fails on .webm audio (mislabeled as video/webm)'. Set mime_type 'audio/webm' yourself; Chrome's MediaRecorder reports 'audio/webm;codecs=opus'. I could not confirm whether the ';codecs=opus' suffix is accepted, so stripping it to 'audio/webm' is safest.

Source: https://github.com/BerriAI/litellm/issues/38963 · confidence: secondary-source

### Size limits: the docs disagree on inline data (100 MB on the newer file-input page, 20 MB total request on the audio page and Firebase). The Files API takes up to 2 GB per file and 20 GB per project, and files expire after 48 hours. One prompt can hold at most 9.5 hours of audio. **(load-bearing)**

file-input-methods: inline data under 100 MB (50 MB for PDFs); external HTTPS or pre-signed URLs up to 100 MB. Audio page: 'Use the Files API for files larger than 20 MB', and use it whenever the total request exceeds 100 MB. Files API: upload via POST https://generativelanguage.googleapis.com/upload/v1beta/files; 2 GB per file, 20 GB per project, 48 h expiry. Audio is downsampled to 16 Kbps. Base64 adds about 33%. Safe choice: keep inline requests under 20 MB.

Source: https://ai.google.dev/gemini-api/docs/file-input-methods · confidence: secondary-source

### Two different audio token rates are published: 32 tokens per second in the audio and tokens docs, and 25 tokens per second in the transcribe pricing estimate.

Audio and tokens docs: 'Gemini represents each second of audio as 32 tokens; one minute = 1,920 tokens.' Pricing page: 'Estimated pricing is based on 25 audio tokens per second.' Read usageMetadata.promptTokensDetails[modality=AUDIO] for the real count. Example: 60 s of audio on 3.5 Flash-Lite ≈ 1,920 × $0.30/1M ≈ $0.00058.

Source: https://ai.google.dev/gemini-api/docs/tokens · confidence: secondary-source

### On any project with an active Cloud Billing account (Paid Services), Google does not use prompts or responses to improve its products. It does keep them for 55 days for abuse monitoring. **(load-bearing)**

Terms: 'When you use Paid Services, including the paid quota of the Gemini API, Google doesn't use your prompts (including associated system instructions, cached content, and files such as images, videos, or documents) or responses to improve our products.' With a Cloud Billing account active, 'all use of Gemini API and Google AI Studio is a Paid Service' for data use, even free-of-charge quota. On unpaid use, content is used for product improvement and human reviewers may read it. Paid prompts and outputs are logged for 55 days for abuse detection, with a separate zero-data-retention (ZDR) option (docs/zdr). Interaction storage (store) is separate and defaults to true.

Source: https://ai.google.dev/gemini-api/terms · confidence: secondary-source

### Rate limits have four usage tiers and now include spend-based limits per 10 minutes. Requests-per-day quotas reset at midnight Pacific time.

Tiers: Free, Tier 1 (linked billing account), Tier 2 and Tier 3 (based on cumulative Google Cloud spend). Spend-based rate limit per rolling 10 minutes: Free N/A, Tier 1 $10, Tier 2 $50, Tier 3 $200. One snippet mentions a $250 monthly cap on Tier 1 (unconfirmed). Per-model RPM, TPM and RPD are shown in the AI Studio rate-limit page. HTTP 429 RESOURCE_EXHAUSTED responses include google.rpc.RetryInfo retryDelay. Per secondary sources, 3.5 Flash-Lite has a free tier (about 5–15 RPM, 1,000 RPD). I could not confirm whether 3.5 Transcribe has a free tier.

Source: https://ai.google.dev/gemini-api/docs/rate-limits · confidence: secondary-source

### More 3.5 Transcribe features: speaker diarization for up to 8 speakers, custom vocabulary of up to 1,000 phrases, and automatic language detection across 85+ languages.

Diarization labels segments spk_1, spk_2 and so on; attribution for 3 or more speakers is experimental. transcription_config.language_codes takes BCP-47 hints; omitting it turns on auto-detection. Interactions mode 'verbatim' is the default; 'smart' removes disfluencies and applies formatting. Deprecated Interactions fields: diarization_mode, timestamp_granularities, language_hints, adaptation_phrases.

Source: https://ai.google.dev/gemini-api/docs/transcribe · confidence: secondary-source
