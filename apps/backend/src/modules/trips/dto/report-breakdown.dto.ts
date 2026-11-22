import { IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class IncidentLocationDto {
  @IsNumber()
  latitude!: number;

  @IsNumber()
  longitude!: number;
}

export class ReportBreakdownDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => IncidentLocationDto)
  incidentLocation?: IncidentLocationDto;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  incidentType?: string;
}
