import { IsNotEmpty, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { VehicleDto } from './vehicle.dto.js';

export class DriverOnboardDto {
  @IsString()
  @IsNotEmpty()
  licenseNumber!: string;

  @ValidateNested()
  @Type(() => VehicleDto)
  vehicle!: VehicleDto;
}
