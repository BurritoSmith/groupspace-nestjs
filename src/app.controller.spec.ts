import { readFileSync } from 'fs';
import { join } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { APP_VERSION } from './app-version';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });

  describe('version', () => {
    it('reports the version constant the deploy stamped in', () => {
      const version = appController.getVersion();

      expect(version.name).toBe('converge-backend');
      expect(version.version).toBe(APP_VERSION);
      // A real semver, not an empty string a broken bump could have written.
      expect(version.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('agrees with package.json, which is what the tag is cut from', () => {
      // The two are written in the same pass by scripts/bump-version.mjs. If they ever disagree,
      // the API is reporting a version that no tag and no release corresponds to.
      const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };

      expect(appController.getVersion().version).toBe(manifest.version);
    });

    it('reports when this process started, not when it was built', () => {
      const { startedAt, builtOn } = appController.getVersion();

      expect(new Date(startedAt).getTime()).not.toBeNaN();
      expect(builtOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});
