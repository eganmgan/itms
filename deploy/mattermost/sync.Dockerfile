FROM golang:1.26 AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/mattermost-sync ./cmd/mattermost-sync

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/mattermost-sync /app/mattermost-sync
USER 1000:1000
EXPOSE 3002
CMD ["/app/mattermost-sync"]
