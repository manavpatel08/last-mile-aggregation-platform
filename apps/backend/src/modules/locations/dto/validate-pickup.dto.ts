import { IsNotEmpty, IsNumber, IsUUID, Max, Min } from 'class-validator';

export class ValidatePickupDto {
  @IsUUID('4', { message: 'pickupPointId must be a valid UUID' })
  @IsNotEmpty()
  pickupPointId!: string;

  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;
}
