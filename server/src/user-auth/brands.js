// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// Per-IdP brand bundles: SVG icon + CSS class + default label/scope/issuer.
// Each brand renders a button class .gsi-<brand>; the CSS for every shipped
// brand lives in views/consent.html so the picker can mix-and-match without
// per-render style injection.

const GOOGLE_G_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" aria-hidden="true">' +
    '<path fill="#FFC107" d="M43.611,20.083H42V20H24v8h11.303c-1.649,4.657-6.08,8-11.303,8c-6.627,0-12-5.373-12-12c0-6.627,5.373-12,12-12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C12.955,4,4,12.955,4,24c0,11.045,8.955,20,20,20c11.045,0,20-8.955,20-20C44,22.659,43.862,21.35,43.611,20.083z"/>' +
    '<path fill="#FF3D00" d="M6.306,14.691l6.571,4.819C14.655,15.108,18.961,12,24,12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C16.318,4,9.656,8.337,6.306,14.691z"/>' +
    '<path fill="#4CAF50" d="M24,44c5.166,0,9.860-1.977,13.409-5.192l-6.190-5.238C29.211,35.091,26.715,36,24,36c-5.202,0-9.619-3.317-11.283-7.946l-6.522,5.025C9.505,39.556,16.227,44,24,44z"/>' +
    '<path fill="#1976D2" d="M43.611,20.083H42V20H24v8h11.303c-0.792,2.237-2.231,4.166-4.087,5.571l6.190,5.238C36.971,39.205,44,34,44,24C44,22.659,43.862,21.35,43.611,20.083z"/>' +
  '</svg>';

const GITHUB_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">' +
    '<path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.26.82-.578 0-.285-.01-1.04-.015-2.04-3.338.726-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.757-1.333-1.757-1.09-.745.082-.73.082-.73 1.205.085 1.838 1.238 1.838 1.238 1.07 1.835 2.807 1.305 3.492.998.108-.776.42-1.305.762-1.605-2.665-.302-5.467-1.333-5.467-5.93 0-1.31.467-2.38 1.235-3.22-.123-.303-.535-1.523.118-3.175 0 0 1.008-.323 3.3 1.23a11.5 11.5 0 016 0c2.29-1.553 3.297-1.23 3.297-1.23.655 1.652.243 2.872.12 3.175.77.84 1.232 1.91 1.232 3.22 0 4.61-2.807 5.625-5.48 5.92.43.37.815 1.103.815 2.222 0 1.605-.015 2.898-.015 3.293 0 .322.217.697.825.578C20.565 21.795 24 17.297 24 12c0-6.63-5.37-12-12-12z"/>' +
  '</svg>';

const MICROSOFT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 23 23" aria-hidden="true">' +
    '<path fill="#f25022" d="M1 1h10v10H1z"/>' +
    '<path fill="#7fba00" d="M12 1h10v10H12z"/>' +
    '<path fill="#00a4ef" d="M1 12h10v10H1z"/>' +
    '<path fill="#ffb900" d="M12 12h10v10H12z"/>' +
  '</svg>';

const APPLE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">' +
    '<path d="M17.05 12.04c-.03-2.93 2.39-4.33 2.5-4.4-1.36-1.99-3.48-2.27-4.24-2.3-1.81-.18-3.53 1.06-4.44 1.06-.91 0-2.33-1.03-3.83-1-1.97.03-3.79 1.14-4.81 2.9-2.05 3.55-.52 8.81 1.48 11.7.97 1.41 2.13 3 3.65 2.95 1.46-.06 2.02-.95 3.79-.95 1.76 0 2.27.95 3.82.92 1.58-.03 2.58-1.45 3.55-2.86 1.12-1.64 1.58-3.22 1.6-3.31-.03-.01-3.07-1.18-3.1-4.71zM14.13 3.78c.81-.97 1.35-2.33 1.2-3.68-1.16.05-2.56.77-3.39 1.74-.75.86-1.4 2.23-1.22 3.56 1.29.1 2.6-.65 3.41-1.62z"/>' +
  '</svg>';

const GITLAB_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path fill="#E24329" d="M12 21.1l3.62-11.14H8.38L12 21.1z"/>' +
    '<path fill="#FC6D26" d="M12 21.1L8.38 9.96H3.07L12 21.1z"/>' +
    '<path fill="#FCA326" d="M3.07 9.96l-1.1 3.4a.75.75 0 00.27.84L12 21.1 3.07 9.96z"/>' +
    '<path fill="#E24329" d="M3.07 9.96h5.31L6.1 2.93a.4.4 0 00-.76 0L3.07 9.96z"/>' +
    '<path fill="#FC6D26" d="M12 21.1l3.62-11.14h5.31L12 21.1z"/>' +
    '<path fill="#FCA326" d="M20.93 9.96l1.1 3.4a.75.75 0 01-.27.84L12 21.1l8.93-11.14z"/>' +
    '<path fill="#E24329" d="M20.93 9.96h-5.31l2.28-7.03a.4.4 0 01.76 0l2.27 7.03z"/>' +
  '</svg>';

const GENERIC_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">' +
    '<path d="M12 2a5 5 0 100 10 5 5 0 000-10zm0 12c-3.86 0-7 2.24-7 5v1h14v-1c0-2.76-3.14-5-7-5z"/>' +
  '</svg>';

// Per-issuer defaults registry — populated when an entry's issuer matches.
const ISSUER_DEFAULTS = {
  'https://accounts.google.com':                    { brand: 'google',    label: 'Sign in with Google',    scope: 'openid' },
  'https://github.com':                             { brand: 'github',    label: 'Sign in with GitHub',    scope: 'openid' },
  'https://login.microsoftonline.com/common/v2.0':  { brand: 'microsoft', label: 'Sign in with Microsoft', scope: 'openid' },
  'https://appleid.apple.com':                      { brand: 'apple',     label: 'Sign in with Apple',     scope: 'openid name email' },
  'https://gitlab.com':                             { brand: 'gitlab',    label: 'Sign in with GitLab',    scope: 'openid' },
};

const BRAND_SVGS = {
  google:    GOOGLE_G_SVG,
  github:    GITHUB_SVG,
  microsoft: MICROSOFT_SVG,
  apple:     APPLE_SVG,
  gitlab:    GITLAB_SVG,
  generic:   GENERIC_SVG,
  trial:     '',   // trial button has no icon
};

export function defaultsForIssuer(issuer) {
  return ISSUER_DEFAULTS[issuer] || { brand: 'generic', scope: 'openid' };
}

export function svgForBrand(brand) {
  return BRAND_SVGS[brand] || BRAND_SVGS.generic;
}
