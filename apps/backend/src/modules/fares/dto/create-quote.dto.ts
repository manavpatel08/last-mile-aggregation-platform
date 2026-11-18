import {
  IsNotEmpty,
  IsNumber,
  IsUUID,
  ValidateNested,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CoordinateDto {
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;
}

export class CreateQuoteDto {
  @IsUUID('4', { message: 'pickupPointId must be a valid UUID' })
  @IsNotEmpty()
  pickupPointId!: string;

  @ValidateNested()
  @Type(() => CoordinateDto)
  @IsNotEmpty()
  destination!: CoordinateDto;
}
