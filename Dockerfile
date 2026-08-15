FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./
# --ignore-scripts: this stage only runs `tsc`, but npm ci also installs tsx (for `npm test`),
# whose esbuild dependency has a postinstall that EXECS the binary it just wrote. Under QEMU
# emulation — any cross-arch build, e.g. linux/amd64 on an arm64 host — that exec races the
# write and dies with ETXTBSY. No dependency here needs its install scripts.
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY index.ts ./
COPY src/ ./src/

RUN npm run build


FROM node:24-alpine AS runtime

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

ENV TRANSPORT=http
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/index.js"]
