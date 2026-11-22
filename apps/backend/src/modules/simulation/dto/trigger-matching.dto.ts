import { IsOptional, IsString } from 'class-validator';

export class TriggerMatchingDto {
  @IsOptional()
  @IsString()
  pickupPointName?: string;
}
