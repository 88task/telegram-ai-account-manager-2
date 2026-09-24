import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

/**
 * Creates a BedrockRuntimeClient supporting both:
 * 1. Single Bearer Token / Bedrock API Key (AWS_BEARER_TOKEN_BEDROCK or BEDROCK_API_KEY)
 * 2. Standard IAM Credentials (AWS_ACCESS_KEY_ID & AWS_SECRET_ACCESS_KEY)
 * 3. Default AWS credentials provider chain (EC2/ECS IAM Role)
 */
export function getBedrockClient(region?: string): BedrockRuntimeClient {
  const targetRegion = region || process.env.AWS_REGION || 'us-east-1';
  const token = process.env.AWS_BEARER_TOKEN_BEDROCK || process.env.BEDROCK_API_KEY;

  const config: Record<string, any> = {
    region: targetRegion
  };

  if (token) {
    config.token = { token };
  } else if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    config.credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    };
  }

  return new BedrockRuntimeClient(config);
}
