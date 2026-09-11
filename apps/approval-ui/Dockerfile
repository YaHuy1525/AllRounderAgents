FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/approval-ui/package.json ./apps/approval-ui/package.json
RUN npm ci --workspace @allrounder/approval-ui --include-workspace-root

COPY apps/approval-ui ./apps/approval-ui

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_API_URL=http://localhost:8000
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

RUN npm run build --workspace @allrounder/approval-ui

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

COPY apps/approval-ui/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/approval-ui/out /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/ || exit 1
