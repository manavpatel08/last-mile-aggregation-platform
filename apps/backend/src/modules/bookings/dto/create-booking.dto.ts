import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CoordinateDto } from '../../fares/dto/create-quote.dto.js';

export class CreateBookingDto {
  @IsUUID('4', { message: 'quoteId must be a valid UUID' })
  @IsNotEmpty()
  quoteId!: string;

  @IsOptional()
  @IsIn(['SHARED', 'PRIVATE'], {
    message: 'requestedType must be either SHARED or PRIVATE',
  })
  requestedType?: 'SHARED' | 'PRIVATE' = 'SHARED';

  @IsOptional()
  @IsInt()
  @Min(2, { message: 'minGroupPreference must be at least 2' })
  @Max(4, { message: 'minGroupPreference cannot exceed 4' })
  minGroupPreference?: number = 2;

  @ValidateNested()
  @Type(() => CoordinateDto)
  @IsNotEmpty()
  passengerPickupLocation!: CoordinateDto;

  @IsBoolean({ message: 'upfrontConsentAgreed must be a boolean' })
  @IsNotEmpty()
  upfrontConsentAgreed!: boolean;
}
