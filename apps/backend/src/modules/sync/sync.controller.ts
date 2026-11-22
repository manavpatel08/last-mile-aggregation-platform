import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator.js';
import { SyncService } from './sync.service.js';
import { SyncRequestDto } from './dto/sync-request.dto.js';
import { SyncResponseDto } from './dto/sync-response.dto.js';

@Controller('sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async reconcile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SyncRequestDto,
  ): Promise<SyncResponseDto> {
    return this.syncService.reconcileState(user.id, user.role, dto);
  }
}
