import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('WebBuilderController (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(['/web-builder', '/web-builder/test'])(
    '%s is accessible without an authorization header',
    async (route) => {
      await request(app.getHttpServer())
        .get(route)
        .expect(200)
        .expect([
          { id: 1, name: 'John Doe' },
          { id: 2, name: 'Jane Doe' },
        ]);
    },
  );
});
