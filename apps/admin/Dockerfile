# ADMIN (backoffice) — build iz korena repozitorijuma: docker build -f apps/admin/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
RUN npm ci -w apps/admin -w apps/web --include-workspace-root
COPY apps/web apps/web
COPY apps/admin apps/admin
RUN npm run build -w apps/admin

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html
EXPOSE 80
