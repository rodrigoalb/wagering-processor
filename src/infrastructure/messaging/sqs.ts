import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { AppConfig } from '../config';

export function createSqsClient(config: AppConfig): SQSClient {
  return new SQSClient({
    endpoint: config.aws.endpoint,
    region: config.aws.region,
    credentials: { accessKeyId: config.aws.accessKeyId, secretAccessKey: config.aws.secretAccessKey },
    maxAttempts: 3,
  });
}

/** Resolve e memoriza URLs de fila (nome -> URL). Não é cache de dados de negócio. */
export class QueueUrls {
  private readonly urls = new Map<string, Promise<string>>();

  constructor(private readonly sqs: SQSClient) {}

  get(queueName: string): Promise<string> {
    let url = this.urls.get(queueName);
    if (!url) {
      url = this.sqs.send(new GetQueueUrlCommand({ QueueName: queueName })).then((r) => r.QueueUrl!);
      url.catch(() => this.urls.delete(queueName));
      this.urls.set(queueName, url);
    }
    return url;
  }
}

export const SQS_CLIENT = Symbol('SQS_CLIENT');
