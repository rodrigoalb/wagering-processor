#!/bin/bash
# Cria as filas FIFO no LocalStack quando ele fica pronto.
set -euo pipefail

MAX_RECEIVE_COUNT=${SQS_REDRIVE_MAX_RECEIVE_COUNT:-6}

awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true,MessageRetentionPeriod=1209600

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

# A redrive policy é rede de segurança: o consumidor move para a DLQ antes,
# explicitamente, quando esgota SQS_MAX_ATTEMPTS (default 5).
awslocal sqs create-queue --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"true\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"${MAX_RECEIVE_COUNT}\\\"}\"}"

awslocal sqs create-queue --queue-name wagering-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

echo "filas criadas"
