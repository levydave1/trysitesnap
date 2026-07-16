# Scenario 02 prompt review

The production cutover intentionally preserves the Make prompt chain: Gemini creates a short analysis, then Claude writes the email. This document proposes the next revision; it is not active in production.

## Why the current emails can feel weak

1. The Gemini system prompt requests `reputation_comment` and `platform_pain`, while its user prompt requests `reputation` and `pain`. The runtime normalizes both forms, but the model receives conflicting schemas.
2. Claude is told not to use "Live Sketch" or criticize the current platform, while the user prompt tells it to mention the Live Sketch and naturally use the pain point. This pushes the model toward awkward compromises.
3. Gemini is asked to invent a platform downside even when the source data does not prove one. That creates either generic language or an unsupported claim.
4. Long avoid-lists and three loose patterns make outputs converge on the same formula. They suppress bad phrases but do not clearly define what a strong email must accomplish.
5. Two model calls repeat the same business context, increase cost and latency, and can lose the best source detail between the analysis and writing stages.

## Recommended design

Use one Claude call that receives only the verified lead fields and returns strict JSON. Keep the email at 35–50 words, use at most one grounded business detail, explain that the draft was made from public information, and end with one permission-based question. Do not mention the detected platform unless it is necessary and factually safe.

Recommended subject constraints:

- 2–5 words.
- Plain text, no hype, no fake urgency.
- Prefer `homepage idea for {business}` or `{business} homepage`.

Recommended body constraints:

- Start with the contact's first name when available.
- Say what was made in the first sentence.
- Give one concrete benefit: clearer services, easier next step, or a better first impression.
- Make no claim about speed, conversion, quality, reputation, or the current website unless the input explicitly proves it.
- End with `Want me to send the preview?` or a natural equivalent.
- No links, pricing, calendar request, marketing jargon, or multi-step pitch in the first email.

## Proposed v2 system prompt

```text
You are David, a website builder writing a first-touch cold email to a local business owner.

Goal: earn a simple reply asking to see a homepage preview that has already been drafted.

Write a plain-text email that sounds personal, direct, and low pressure.

Rules:
- Body length: 35 to 50 words.
- Subject length: 2 to 5 words.
- Use the contact's first name when available.
- In the first sentence, say that you drafted a homepage concept for this business using public information.
- Use at most one verified detail from the input. If no useful detail exists, do not invent one.
- Mention one practical benefit only: clearer services, an easier next step, or a stronger first impression.
- Do not criticize the current website or platform.
- Do not claim that the site is slow, outdated, confusing, or underperforming.
- Do not use exaggerated compliments, fake familiarity, urgency, pricing, links, or a meeting request.
- Do not use the phrase "Live Sketch" in the first email.
- End with one natural permission question asking whether to send the preview.
- Vary the wording while preserving these rules.

Return only valid JSON with exactly these keys:
{"subject":"...","body":"..."}
```

## Proposed v2 user prompt

```text
Write the email for this verified lead:

Contact first name: {{first_name}}
Business: {{business_name}}
Category: {{category}}
City: {{city}}
Public description: {{website_description_or_about}}
Current website: {{website}}

Choose at most one grounded detail from the public description. If it is vague, omit personalization instead of guessing.
```

## Example

Subject: `homepage idea for Aaron`

Body: `Ryan — I drafted a cleaner homepage concept for Aaron Overhead Doors using the public info from your Buford page. It puts repair and installation options up front and makes the next step easier to find. Want me to send the preview?`

## Suggested rollout

Run the current and v2 prompts on 20–30 comparable leads, then compare positive reply rate, preview-request rate, invalid/unsubscribed rate, model cost, and manual quality scores. Activate v2 only after the sample is reviewed.
