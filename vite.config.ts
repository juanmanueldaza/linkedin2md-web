import { defineConfig, type Plugin } from 'vite'

/**
 * GitHub Pages cannot set response headers, so the CSP must ship inside the HTML.
 * It is injected at build time only: `connect-src 'none'` would block the Vite HMR
 * websocket in development. Keep this string in sync with public/privacy.html.
 */
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; base-uri 'self'"

function cspMeta(): Plugin {
  return {
    name: 'linkedin2md-csp-meta',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
          injectTo: 'head-prepend',
        },
      ]
    },
  }
}

export default defineConfig({
  plugins: [cspMeta()],
})
