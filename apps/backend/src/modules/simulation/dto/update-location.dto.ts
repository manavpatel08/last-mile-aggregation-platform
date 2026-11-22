import { IsNumber } from 'class-validator';

export class UpdateSimulationLocationDto {
  @IsNumber()
  latitude!: number;

  @IsNumber()
  longitude!: number;
}
