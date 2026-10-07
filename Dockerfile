# Web app image. Used by docker-compose.demo.yml, and usable on its own in production.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production \
    PORT=3000 \
    NEXT_TELEMETRY_DISABLED=1

EXPOSE 3000

# Apply migrations, optionally load demo data, then start the server.
CMD ["sh", "-c", "npx drizzle-kit migrate && if [ \"$DEMO_SEED\" = \"true\" ]; then npm run db:seed; fi && npx next start -H 0.0.0.0 -p ${PORT:-3000}"]
