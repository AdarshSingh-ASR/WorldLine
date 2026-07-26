FROM public.ecr.aws/docker/library/node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
USER node
CMD ["node", "src/consumer.mjs"]
