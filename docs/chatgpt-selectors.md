# ChatGPT selector map — snapshot 2026-09-06

Selectors were derived from the three supplied browser snapshots: empty chat, attachments, and completed generated image.

## Stable selectors observed

| Purpose | Primary | Fallback |
|---|---|---|
| New chat | `[data-testid="create-new-chat-button"]` | `a[aria-label="Новый чат"]` |
| Composer | `#prompt-textarea[contenteditable="true"]` | `[role="textbox"][contenteditable="true"][aria-label*="ChatGPT"]` |
| Plus button | `[data-testid="composer-plus-btn"]` | `#composer-plus-btn` |
| Image input | `input[data-testid="upload-photos-input"]` | `#upload-photos`, then `#upload-files[data-photo-upload-enabled="true"]` |
| Send | `#composer-submit-button` | `[data-testid="send-button"]`, `button[aria-label="Отправить промпт"]` |
| User turn | `[data-turn="user"]` | — |
| Assistant turn | `[data-turn="assistant"]` | — |
| Generated image | latest assistant turn → `img[alt^="Сформированное изображение"]` | latest assistant turn → `[id^="image-"] img:not([aria-hidden="true"])` |
| Image overlay marker | `[data-testid="image-gen-overlay-actions"]` | — |

## Important finding about download

The supplied completed-generation snapshot contains `data-testid="download-files-turn-action-button"` with `aria-label="Скачать 4 файла"`, but that button belongs to the USER turn and downloads the four uploaded input files. It is not a generated-image download button.

The completed generated-image card itself exposes Edit and Share overlay actions, but no generated-image Download control in the captured state. Therefore MVP 0.1 downloads the final image by its already-rendered signed `img.src` using the Chrome Downloads API and assigns the intended filename. This avoids accidentally downloading the four source files.

If a later UI/modal reveals a dedicated generated-image Download button, add a fourth snapshot with that modal open and implement it as the preferred strategy.
