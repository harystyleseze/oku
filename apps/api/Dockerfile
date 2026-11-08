FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci --workspace apps/api
COPY apps/api apps/api
RUN npm run build -w apps/api

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/apps/api/package.json apps/api/
RUN npm ci --workspace apps/api --omit=dev
COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/drizzle apps/api/drizzle
WORKDIR /app/apps/api
EXPOSE 4000
# Run migrations, then serve.
CMD ["sh", "-c", "node dist/migrate.js && node dist/index.js"]
