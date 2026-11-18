import { IsIn, IsInt, IsNotEmpty, IsString, Max, Min } from 'class-validator';

export class VehicleDto {
  @IsString()
  @IsNotEmpty()
  registrationNumber!: string;

  @IsString()
  @IsIn(['E_RICKSHAW', 'BIKE_TAXI', 'SHUTTLE_VAN'])
  vehicleType: string = 'E_RICKSHAW';

  @IsInt()
  @Min(1)
  @Max(8)
  passengerCapacity: number = 4;

  @IsString()
  @IsNotEmpty()
  makeModel!: string;
}
