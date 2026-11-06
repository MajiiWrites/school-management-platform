# School Management Platform — web image
# Builds the React/Vite SPA and serves it with nginx. /api/ is reverse-proxied
# to the api service, so the frontend can be built with a relative API URL
# (VITE_API_URL=/api/v1) and the whole platform works from one origin.
# syntax=docker/dockerfile:1
FROM node:20-alpine AS build
WORKDIR /app
ARG VITE_API_URL=/api/v1
ENV VITE_API_URL=$VITE_API_URL
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
