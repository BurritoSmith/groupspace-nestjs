import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { APP_VERSION, BUILD_DATE, STARTED_AT } from './app-version';

export interface IVersionResponse {
  name: string;
  version: string;
  builtOn: string;
  startedAt: string;
}

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /** Deliberately left alone: both deploy workflows health-check this route and only care that it
   *  returns 200. Version information lives at /version rather than changing this body. */
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * What is deployed, for anyone asking "did that deploy actually land?".
   *
   * Unauthenticated on purpose — it reports a version number and a boot time, both of which are
   * already public knowledge from the tags and the release page, and being able to check it without
   * credentials is the entire point during an incident.
   */
  @Get('version')
  getVersion(): IVersionResponse {
    return {
      name: 'converge-backend',
      version: APP_VERSION,
      builtOn: BUILD_DATE,
      startedAt: STARTED_AT,
    };
  }
}
