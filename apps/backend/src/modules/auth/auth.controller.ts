import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { AuthService } from './auth.service.js';
import type {
  AuthResponse,
  RefreshResponse,
  SocketTicketResponse,
} from './auth.service.js';
import { GoogleAuthDto } from './dto/google-auth.dto.js';
import { RefreshTokenDto } from './dto/refresh-token.dto.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('google')
  @HttpCode(HttpStatus.OK)
  async authenticateWithGoogle(
    @Body() dto: GoogleAuthDto,
  ): Promise<{ success: boolean; data: AuthResponse }> {
    const data = await this.authService.authenticateWithGoogle(
      dto.idToken,
      dto.deviceFingerprint,
    );
    return {
      success: true,
      data,
    };
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refreshSession(
    @Body() dto: RefreshTokenDto,
  ): Promise<{ success: boolean; data: RefreshResponse }> {
    const data = await this.authService.refreshSession(
      dto.refreshToken,
      dto.deviceFingerprint,
    );
    return {
      success: true,
      data,
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ success: boolean; message: string }> {
    return this.authService.logout(user.sessionId);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  async logoutAll(
    @CurrentUser('id') userId: string,
  ): Promise<{ success: boolean; message: string }> {
    return this.authService.logoutAll(userId);
  }

  @Get('socket-ticket')
  async getSocketTicket(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ success: boolean; data: SocketTicketResponse }> {
    const data = await this.authService.generateSocketTicket(
      user.id,
      user.role,
      user.driverVerificationStatus,
      user.sessionId,
    );
    return {
      success: true,
      data,
    };
  }
}
