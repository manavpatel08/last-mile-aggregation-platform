import { IsInt, IsOptional, IsUUID, Min } from 'class-validator';

export class SyncRequestDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  lastKnownEntityVersion?: number;

  @IsOptional()
  @IsUUID()
  activeBookingId?: string;

  @IsOptional()
  @IsUUID()
  activeTripId?: string;
}
