import { gotScraping } from 'got-scraping';

export class Solvium {
  constructor(apiKey) {
    this.client = gotScraping.extend({
      prefixUrl: 'https://captcha.solvium.io/api/v1',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
  }

  async createVercelTask(challengeToken) {
    const response = await this.client.get('task/vercel', {
      searchParams: {
        challengeToken,
      },
      responseType: 'json',
    });
    const body = response.body;

    if (response.ok && body.message === 'Task created' && body.task_id) {
      return body.task_id;
    }

    throw new Error('Failed to create a vercel task');
  }

  async getTaskResult(taskId) {
    const maxAttempts = 30;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await this.client.get(`task/status/${taskId}`, { responseType: 'json' });
        const body = response.body;

        if (body.status === 'completed') {
          return body.result.solution;
        }
        if (body.status === 'running' || body.status === 'pending') {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        throw new Error(`Task failed: ${JSON.stringify(body, null, 2)}`);
      } catch {}
    }

    throw new Error(`Unable to pull task result in ${maxAttempts} attempts`);
  }
}
