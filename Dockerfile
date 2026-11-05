# Travel CRM API — container image for Render (or any Docker host).
#
# A plain Node runtime would be enough for the API itself, but NOT for the PDFs. The server
# renders quotations, receipts and GST invoices by driving a real browser through
# `puppeteer-core`, which deliberately bundles no Chrome of its own. On a bare Node host
# every PDF fails with "No Chrome/Chromium found on this server" while the rest of the app
# looks perfectly healthy — so the browser is installed here, at the image level.

FROM node:22-slim

# Chromium plus the fonts and libraries a headless render actually needs.
#
# Without the font packages Chromium still launches and still produces a PDF — one where
# every rupee sign, every Indian-language name and every emoji is a hollow box. That failure
# is silent and only shows up on a document already sent to a guest, so the fonts are not
# optional here.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      fonts-dejavu-core \
      fonts-noto-core \
      fonts-noto-color-emoji \
      ca-certificates \
      dumb-init \
    && rm -rf /var/lib/apt/lists/*

# `puppeteer-core` ships no browser, so nothing downloads one at install time either; this is
# belt-and-braces in case a transitive dependency tries.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    CHROME_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app

# Dependencies first, so a code-only change does not reinstall node_modules on every deploy.
COPY package*.json ./
# `npm ci` needs a lockfile; fall back to `npm install` so a checkout without one still builds
# rather than failing at the last step of a deploy.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY . .

# Run as the image's existing unprivileged user. Chromium is happy headless as non-root, and
# anything that escapes a rendered HTML document then lands as `node`, not as root.
# /tmp is used for the PDF image cache, so it has to stay writable.
RUN mkdir -p /app/uploads && chown -R node:node /app
USER node

EXPOSE 5000

# dumb-init reaps the zombie processes Chromium leaves behind. Without an init, a long-running
# container slowly fills its process table with defunct renderers until no new PDF can start.
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "src/server.js"]
