import { MiddlewareConsumer, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WebBuilderModule } from './web-builder/web-builder.module';
import { ApiMiddleware, CustomLogger } from '@spsedu360/common-be-config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    WebBuilderModule,
  ],
  controllers: [],
  providers: [CustomLogger],
  exports: [CustomLogger],
})
export class AppModule {
  constructor() {
    CustomLogger.setAppName('Builder-Service');
  }
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(ApiMiddleware).forRoutes('*');
  }
}
