FROM ubuntu:latest
WORKDIR /app

RUN apt update && \
    apt install -y golang-go nodejs npm libgtk2.0-0t64 libgtk-3-0t64 libgbm-dev libnotify-dev libnss3 libxss1 libasound2t64 libxtst6 xauth xvfb && \
    npm install -g corepack

RUN corepack enable && \
    yarn install

RUN git clone https://github.com/scripthaus-dev/scripthaus.git
WORKDIR /app/scripthaus

RUN CGO_ENABLED=1 go build -o scripthaus cmd/main.go && \
    cp scripthaus /usr/local/bin

WORKDIR /app
RUN mkdir waveterm

WORKDIR /app/waveterm
COPY . .
ENV GOFLAGS="-buildvcs=false"
ENV DISPLAY=":0"

RUN useradd -ms /bin/bash wave