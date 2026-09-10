FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache su-exec
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/arkade-watchtower-entrypoint
RUN chmod +x /usr/local/bin/arkade-watchtower-entrypoint
ENV PORT=3000
EXPOSE 3000
ENTRYPOINT ["arkade-watchtower-entrypoint"]
CMD ["npm", "start"]
