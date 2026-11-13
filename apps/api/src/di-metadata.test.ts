// Toolchain guard, not a feature test. It proves that the test runner emits decorator metadata,
// which NestJS needs to inject a dependency by its constructor parameter type.
// Resolves unverified item U2 in docs/PLAN.md.
import 'reflect-metadata';
import { Controller, Get, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

@Injectable()
class GreetingService {
  greet(): string {
    return 'hello';
  }
}

@Controller()
class GreetingController {
  // No @Inject() here on purpose: Nest must find GreetingService from the emitted
  // `design:paramtypes` metadata alone.
  constructor(private readonly greetings: GreetingService) {}

  @Get()
  hello(): string {
    return this.greetings.greet();
  }
}

describe('decorator metadata under Vitest (U2)', () => {
  it('emits design:paramtypes for a decorated class', () => {
    const paramTypes: unknown = Reflect.getMetadata('design:paramtypes', GreetingController);
    expect(paramTypes).toEqual([GreetingService]);
  });

  it('lets NestJS inject by constructor type without an explicit @Inject()', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [GreetingController],
      providers: [GreetingService],
    }).compile();

    expect(moduleRef.get(GreetingController).hello()).toBe('hello');
    await moduleRef.close();
  });
});
