import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { GoogleAuthService } from './google-auth.service.js';
import { TokenService } from './token.service.js';
import { SessionService } from './session.service.js';

@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>(
          'jwt.accessSecret',
          'dev-access-secret-minimum-32-chars-long-placeholder!',
        ),
        signOptions: {
          expiresIn: config.get<number>('jwt.accessExpiry', 900),
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, GoogleAuthService, TokenService, SessionService],
  exports: [AuthService, TokenService, SessionService, JwtModule],
})
export class AuthModule {}
