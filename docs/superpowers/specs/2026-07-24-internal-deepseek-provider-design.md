# Internal DeepSeek Provider Design

## Goal

Allow a workspace administrator to enable an internal DeepSeek mode from System Settings. When enabled, the application must use DeepSeek's official OpenAI-compatible endpoint and the fixed `deepseek-v4-flash` model. The administrator supplies a DeepSeek API key in the settings page; the key is encrypted at rest and never returned by an API response.

## Scope

- Add `deepseek` as a controlled model provider.
- Add an “内部启用 DeepSeek” setting mode.
- Require an API key when DeepSeek is first enabled.
- Fix the endpoint and model on the server; clients cannot override either value.
- Keep existing OpenAI-compatible and Anthropic choices available when the mode is off.
- Store credentials by provider identity so a DeepSeek key is never silently reused for another provider.

## Data and API contract

`ModelProvider` will include `deepseek`. Model settings retain the existing sanitized response shape: provider, model, and `hasApiKey`; plaintext credentials and endpoint details are never returned.

For `provider: "deepseek"`, the write endpoint ignores any client-selected model and persists `deepseek-v4-flash`. It requires a non-empty key if no DeepSeek credential exists. The provider implementation uses `https://api.deepseek.com` internally.

Existing `model-provider` credentials remain the backward-compatible credential identity for OpenAI-compatible and Anthropic settings. DeepSeek uses the separate `model-provider-deepseek` identity. This prevents a blank-key update for another provider from preserving and later sending a DeepSeek key to a different endpoint.

## Settings interaction

The model section contains a labelled DeepSeek enable control.

- When off, the existing provider selector, editable model field, and API-key behavior appear.
- When on, the generic selector and model field are hidden. The page states that the service is DeepSeek and the model is `deepseek-v4-flash`.
- The API-key field remains masked and uses `autocomplete="new-password"`. On a later visit, it displays only “已安全存储”; leaving it blank retains the DeepSeek credential.
- Turning the mode off does not delete any stored credential. A user must intentionally replace or rotate a key.

## Error handling and security

- Only workspace administrators can read or update model settings, matching the current authorization boundary.
- Invalid provider values, missing first-use keys, and malformed requests return the existing stable model-settings error behavior.
- The API key is encrypted with the existing master-key encryption path and is omitted from GET and PUT responses, audit metadata, and logs.
- Server-side provider selection owns endpoint selection. A browser request cannot redirect an API key to an arbitrary OpenAI-compatible endpoint.

## Tests and acceptance criteria

1. Model-settings API tests prove a DeepSeek key is encrypted, sanitized, and stored under the DeepSeek credential identity.
2. Tests prove a first DeepSeek enable without a key is rejected and a subsequent blank-key save retains only the DeepSeek credential.
3. Enhancer/bootstrap tests prove DeepSeek resolves to the official endpoint and fixed flash model.
4. Settings-page tests prove enabling the mode hides generic controls, displays the fixed model, and retains safe autofill attributes.
5. Existing OpenAI-compatible and Anthropic behavior remains covered by regression tests.

## Non-goals

- No API key is accepted through chat or source control.
- No production key is generated, copied, or logged during implementation.
- No automatic billing, account creation, or provider health check is added.
