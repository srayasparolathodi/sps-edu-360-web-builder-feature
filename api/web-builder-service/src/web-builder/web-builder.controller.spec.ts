import { Test, TestingModule } from '@nestjs/testing';
import { WebBuilderController } from './web-builder.controller';
import { WebBuilderService } from './web-builder.service';

describe('WebBuilderController', () => {
  let controller: WebBuilderController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebBuilderController],
      providers: [WebBuilderService],
    }).compile();

    controller = module.get<WebBuilderController>(WebBuilderController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
