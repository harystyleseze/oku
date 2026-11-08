FROM node:22-bookworm-slim AS build
WORKDIR /app
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
RUN npm ci --workspace apps/web
COPY apps/web apps/web
RUN npm run build -w apps/web

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/apps/web/package.json apps/web/
RUN npm ci --workspace apps/web --omit=dev
COPY --from=build /app/apps/web/.next apps/web/.next
COPY --from=build /app/apps/web/public apps/web/public
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
