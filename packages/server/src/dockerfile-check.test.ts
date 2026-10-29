import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  finalStageIsProduction,
  missingEntryCopies,
  missingVersionEnv,
} from './dockerfile-check.js';

const DOCKERFILE = readFileSync(
  new URL('../Dockerfile.prod', import.meta.url),
  'utf8',
);

describe('Dockerfile.prod', () => {
  it('🔒 本番イメージは NODE_ENV=production を明示する（dev ログインの抜け道を開かない。prd/07 §6.1）', () => {
    expect(finalStageIsProduction(DOCKERFILE)).toBe(true);
  });

  it('所有者の付け替えのエントリを同梱する（prd/07 §4.1）', () => {
    expect(
      missingEntryCopies(DOCKERFILE, [
        'server',
        'migrate',
        'link-owner-account',
      ]),
    ).toEqual([]);
  });

  it('最終ステージがビルドの版をビルド引数から ENV へ渡す（GET /api/version。prd/02 §5）', () => {
    expect(missingVersionEnv(DOCKERFILE)).toEqual([]);
  });
});

describe('missingVersionEnv', () => {
  it('ビルドステージだけにあっても渡したとみなさない', () => {
    expect(
      missingVersionEnv(
        'FROM a AS build\nARG GIT_COMMIT\nENV GIT_COMMIT=$GIT_COMMIT\nFROM b\n',
      ),
    ).toEqual(['GIT_COMMIT', 'BUILD_TIME', 'GIT_DIRTY']);
  });

  it('ARG と ENV が揃っていれば足りている', () => {
    expect(
      missingVersionEnv(
        'FROM b\nARG GIT_COMMIT=unknown\nARG BUILD_TIME\nARG GIT_DIRTY=false\n' +
          'ENV GIT_COMMIT=$GIT_COMMIT BUILD_TIME=$BUILD_TIME\nENV GIT_DIRTY=$GIT_DIRTY\n',
      ),
    ).toEqual([]);
  });
});

describe('finalStageIsProduction', () => {
  it('ビルドステージだけにあっても本番とみなさない', () => {
    expect(
      finalStageIsProduction(
        'FROM a AS build\nENV NODE_ENV=production\nFROM b\nCMD ["x"]\n',
      ),
    ).toBe(false);
  });

  it('最終ステージにあれば本番', () => {
    expect(
      finalStageIsProduction(
        'FROM a AS build\nFROM b\nENV NODE_ENV=production\n',
      ),
    ).toBe(true);
  });

  it('development は本番とみなさない', () => {
    expect(finalStageIsProduction('FROM b\nENV NODE_ENV=development\n')).toBe(
      false,
    );
  });
});

describe('missingEntryCopies', () => {
  it('COPY の無いエントリを返す', () => {
    expect(missingEntryCopies('COPY dist/a.js ./a.js', ['a', 'b'])).toEqual([
      'b',
    ]);
  });
});
