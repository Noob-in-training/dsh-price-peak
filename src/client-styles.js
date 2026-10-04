/**
 * Styles for the price-peak dock entry.
 *
 * Class names are prefixed with the bundle's short package id so they cannot
 * collide with another plugin's sheet, matching the shipped client bundles'
 * convention. Every colour is a theme token, so light and dark both work and the
 * panel follows the user's accent.
 *
 * ## Width
 *
 * The content column this dock sits in is, by the shipped definition,
 * `clamp(680px, conversation-column × 0.64, 920px)`, and the composer card is
 * that plus 32px. The honest target is therefore "the content column", whose
 * documented ceiling is 920px.
 *
 * Two traps were hit here, both worth remembering before "just" following a token:
 *
 * 1. `max-width: calc(var(--token) - 32px)` is INVALID when the token is absent,
 *    so the declaration drops, `max-width` falls back to `none`, and the element
 *    goes full-bleed across the window. Every width below is valid on its own.
 * 2. Following an outer column-width token puts the dock at the mercy of where the
 *    slot is rendered. Measured on a ~2300px window the bar spanned ~2220px while
 *    the composer card was a few hundred wide. The cap has to be absolute, and
 *    `min(920px, 100%)` keeps it bounded without ever overflowing.
 *
 * `.dppDock` sets the column width from the clearance and inset tokens — the same
 * formula the shipped Goal bar uses — and must NOT be a flex row, because the bar
 * and the panel are stacked children of it.
 */
const css = `
.dppDock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance, 16px) - var(--dsh-composer-side-clearance, 16px) - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px));margin:0 auto}
.dppBar{isolation:isolate;box-sizing:border-box;width:100%;max-width:min(920px, 100%);border-radius:var(--dsw-radius-md);border:0;box-shadow:none;margin:0 auto;padding:4px 8px;display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;position:relative;color:var(--dsw-alias-label-secondary);background:0 0;cursor:default}
.dppBar:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dppBadge{flex:none;font-weight:600;font-variant-numeric:tabular-nums;padding:0 6px;border-radius:var(--dsw-radius-sm);line-height:16px}
.dppPeak{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent)}
.dppOff{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)}
.dppUnknown{color:var(--dsw-alias-state-idle-primary);background:color-mix(in srgb, var(--dsw-alias-state-idle-primary) 14%, transparent)}
.dppClock{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}
.dppReason{min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.dppNext{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}
.dppDot{flex:none;width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-state-success-primary)}
.dppDotStale{background:var(--dsw-alias-state-warn-primary)}
.dppDotError{background:var(--dsw-alias-state-error-primary)}
.dppToggle{flex:none;border:0;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0 2px;font-size:11px;line-height:16px}
.dppToggle:hover{color:var(--dsw-alias-label-primary)}
.dppPanel{box-sizing:border-box;width:100%;max-width:min(920px, 100%);border-radius:var(--dsw-radius-md);margin:4px auto 0;padding:10px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-specific-menu);border:.5px solid var(--dsw-alias-border-l1);backdrop-filter:var(--dsw-menu-backdrop-filter)}
.dppRow{display:flex;justify-content:space-between;gap:12px;padding:1px 0}
.dppRow span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dppRow span:last-child{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.dppHead{margin:8px 0 2px;color:var(--dsw-alias-label-primary);font-weight:600}
.dppHead:first-child{margin-top:0}
.dppRule{margin-top:8px;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dppWarn{color:var(--dsw-alias-state-warn-primary)}
.dppErr{color:var(--dsw-alias-state-error-primary)}
`;

export { css };
