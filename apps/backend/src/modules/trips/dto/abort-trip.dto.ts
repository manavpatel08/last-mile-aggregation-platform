import { IsOptional, IsString } from 'class-validator';

export class AbortTripDto {
  @IsOptional()
  @IsString()
  reason?: string;
}
