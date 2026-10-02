// Applies the saved theme before first paint, so a forced scheme does not flash the
// system one. web/theme.ts writes the cookie. Other local apps share loopback cookies,
// so only an exact known value is applied.
{
  const theme = /(?:^|; )chittr-theme=(light|dark)(?:;|$)/.exec(document.cookie)?.[1];
  if (theme) document.documentElement.dataset.theme = theme;
}
