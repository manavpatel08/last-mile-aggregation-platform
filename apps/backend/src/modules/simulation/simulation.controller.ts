import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SimulationService } from './simulation.service.js';
import { TriggerMatchingDto } from './dto/trigger-matching.dto.js';
import { UpdateSimulationLocationDto } from './dto/update-location.dto.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.decorator.js';

@Controller('admin/simulation')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class SimulationController {
  constructor(private readonly simulationService: SimulationService) {}

  @Post('provision-agents')
  @HttpCode(HttpStatus.OK)
  async provisionAgents() {
    const data = await this.simulationService.provisionAgents();
    return {
      success: true,
      message: 'Virtual passenger and driver agents provisioned',
      data,
    };
  }

  @Post('create-bookings')
  @HttpCode(HttpStatus.CREATED)
  async createDemoBookings() {
    const data = await this.simulationService.createDemoBookings();
    return {
      success: true,
      message: 'Demo shared bookings created along Bhaijipura-Kudasan corridor',
      data,
    };
  }

  @Post('trigger-matching')
  @HttpCode(HttpStatus.OK)
  async triggerMatching(@Body() dto?: TriggerMatchingDto) {
    const pickupPointName = dto?.pickupPointName || 'PDEU Demo Station';
    const summary = await this.simulationService.triggerMatching(pickupPointName);
    return {
      success: true,
      message: 'Matching cycle executed',
      data: summary,
    };
  }

  @Get('active-journey')
  async getActiveJourney() {
    const data = await this.simulationService.getActiveJourney();
    return {
      success: true,
      data,
    };
  }

  @Post('progress-step')
  @HttpCode(HttpStatus.OK)
  async progressStep() {
    const data = await this.simulationService.progressStep();
    return {
      success: true,
      data,
    };
  }

  @Post('location')
  @HttpCode(HttpStatus.OK)
  async updateLocation(@Body() dto: UpdateSimulationLocationDto) {
    const data = await this.simulationService.updateDriverLocation(
      dto.latitude,
      dto.longitude,
    );
    return {
      success: true,
      data,
    };
  }

  @Post('reset')
  @HttpCode(HttpStatus.OK)
  async resetSimulation() {
    const data = await this.simulationService.resetSimulation();
    return data;
  }
}
