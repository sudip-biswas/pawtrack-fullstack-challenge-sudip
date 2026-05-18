import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AuthContext, BookingStatus } from '../types/index.js';
import { bookingService } from '../services/booking-service.js';
import { store } from '../store/memory-store.js';

export function bookingRoutes(app: FastifyInstance): void {
  /**
   * GET /api/bookings
   * List bookings with optional filters and pagination.
   */
  app.get('/api/bookings', async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = (request as any).auth as AuthContext;
    const query = request.query as {
      page?: string;
      limit?: string;
      date?: string;
      status?: string;
    };

    // Always scope to the authenticated tenant — never allow a client-supplied
    // tenantId override, which would let any user read another tenant's data.
    const tenantId = auth.tenantId;

    const page = parseInt(query.page || '1', 10);
    const limit = parseInt(query.limit || '10', 10);

    const result = bookingService.listBookings({
      tenantId,
      page,
      limit,
      date: query.date,
      status: query.status as BookingStatus | undefined,
    });

    return reply.code(200).send(result);
  });

  /**
   * GET /api/bookings/:id
   * Get a single booking by ID.
   */
  app.get('/api/bookings/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = (request as any).auth as AuthContext;
    const { id } = request.params as { id: string };
    const booking = bookingService.getBooking(id);

    if (!booking) {
      return reply.code(404).send({ error: 'Booking not found' });
    }

    // Enforce tenant isolation — return 404 (not 403) to avoid confirming
    // that a booking with this ID exists in another tenant.
    if (booking.tenantId !== auth.tenantId) {
      return reply.code(404).send({ error: 'Booking not found' });
    }

    return reply.code(200).send({ data: booking });
  });

  /**
   * POST /api/bookings
   * Create a new booking.
   */
  app.post(
    '/api/bookings',
    {
      schema: {
        body: {
          type: 'object',
          required: ['petId', 'sitterId', 'scheduledDate', 'startTime', 'endTime'],
          properties: {
            petId:          { type: 'string', minLength: 1 },
            sitterId:       { type: 'string', minLength: 1 },
            scheduledDate:  { type: 'string', minLength: 1 },
            startTime:      { type: 'string', minLength: 1 },
            endTime:        { type: 'string', minLength: 1 },
            notes:          { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = (request as any).auth as AuthContext;
      const body = request.body as {
        petId: string;
        sitterId: string;
        scheduledDate: string;
        startTime: string;
        endTime: string;
        notes?: string;
      };

      // Validate that the pet and sitter both belong to this tenant.
      // Without this check a user could book a sitter from another tenant,
      // corrupting cross-tenant data integrity.
      const pet = store.getPet(body.petId);
      if (!pet || pet.tenantId !== auth.tenantId) {
        return reply.code(422).send({ error: 'Pet not found for this tenant' });
      }

      const sitter = store.getSitter(body.sitterId);
      if (!sitter || sitter.tenantId !== auth.tenantId) {
        return reply.code(422).send({ error: 'Sitter not found for this tenant' });
      }

      try {
        const booking = bookingService.createBooking({
          tenantId: auth.tenantId,
          petId: body.petId,
          sitterId: body.sitterId,
          scheduledDate: body.scheduledDate,
          startTime: body.startTime,
          endTime: body.endTime,
          notes: body.notes || '',
          createdBy: auth.userId,
        });

        return reply.code(201).send({ success: true, data: booking });
      } catch (error: any) {
        // Sitter overlap conflicts are 409; other errors are 422
        const isConflict = error.message?.includes('overlapping');
        return reply.code(isConflict ? 409 : 422).send({ success: false, error: error.message });
      }
    },
  );

  /**
   * PATCH /api/bookings/:id/status
   * Update the status of a booking.
   */
  app.patch('/api/bookings/:id/status', async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = (request as any).auth as AuthContext;
    const { id } = request.params as { id: string };
    const { status } = request.body as { status: BookingStatus };

    // Fetch the booking first so we can verify tenant ownership before mutating.
    const booking = bookingService.getBooking(id);
    if (!booking) {
      return reply.code(404).send({ success: false, error: 'Booking not found' });
    }

    if (booking.tenantId !== auth.tenantId) {
      return reply.code(404).send({ success: false, error: 'Booking not found' });
    }

    const result = bookingService.updateStatus(id, status, auth.userId);

    if (!result.success) {
      return reply.code(422).send(result);
    }

    return reply.code(200).send(result);
  });
}
