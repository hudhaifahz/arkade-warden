FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
