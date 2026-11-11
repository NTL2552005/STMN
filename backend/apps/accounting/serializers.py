from rest_framework import serializers

from .models import ExpenseVoucher, ReceiptVoucher, SupplierDebt, SupplierPayment


class SupplierPaymentSerializer(serializers.ModelSerializer):
    debt_code = serializers.CharField(source="debt.receipt.code", read_only=True)
    supplier_code = serializers.CharField(source="debt.supplier.code", read_only=True)

    class Meta:
        model = SupplierPayment
        fields = (
            "code",
            "debt_code",
            "supplier_code",
            "payment_date",
            "amount",
            "method",
            "status",
            "note",
            "created_at",
        )
        read_only_fields = fields


class SupplierDebtSerializer(serializers.ModelSerializer):
    code = serializers.CharField(source="receipt.code", read_only=True)
    supplier_code = serializers.CharField(source="supplier.code", read_only=True)
    supplier_name = serializers.CharField(source="supplier.name", read_only=True)
    receipt_amount = serializers.IntegerField(source="amount", read_only=True)
    returned_amount = serializers.SerializerMethodField()
    paid_amount = serializers.SerializerMethodField()
    pending_amount = serializers.SerializerMethodField()
    balance = serializers.SerializerMethodField()
    supplier_credit = serializers.SerializerMethodField()

    class Meta:
        model = SupplierDebt
        fields = (
            "code",
            "supplier_code",
            "supplier_name",
            "receipt_amount",
            "returned_amount",
            "paid_amount",
            "pending_amount",
            "balance",
            "supplier_credit",
            "created_at",
        )

    def get_returned_amount(self, debt):
        return sum(row.amount for row in debt.return_adjustments.all())

    def get_paid_amount(self, debt):
        return sum(
            row.amount
            for row in debt.payments.all()
            if row.status == SupplierPayment.Status.SUCCESS
        )

    def get_pending_amount(self, debt):
        return sum(
            row.amount
            for row in debt.payments.all()
            if row.status == SupplierPayment.Status.PENDING
        )

    def get_balance(self, debt):
        return max(
            0,
            debt.amount - self.get_returned_amount(debt) - self.get_paid_amount(debt),
        )

    def get_supplier_credit(self, debt):
        return max(
            0,
            self.get_returned_amount(debt) + self.get_paid_amount(debt) - debt.amount,
        )


class ReceiptVoucherSerializer(serializers.ModelSerializer):
    employee_code = serializers.CharField(source="employee.code", read_only=True)
    employee_name = serializers.CharField(source="employee.full_name", read_only=True)
    sale_payment_code = serializers.CharField(
        source="sale_payment.code", read_only=True, allow_null=True
    )
    customer_code = serializers.CharField(
        source="customer.DT_Ma", read_only=True, allow_null=True
    )
    customer_name = serializers.CharField(
        source="customer.DT_Ten", read_only=True, allow_null=True
    )

    class Meta:
        model = ReceiptVoucher
        fields = (
            "code",
            "sale_payment_code",
            "customer_code",
            "customer_name",
            "employee_code",
            "employee_name",
            "voucher_date",
            "amount",
            "reason",
            "method",
            "status",
            "note",
        )
        read_only_fields = fields


class ExpenseVoucherSerializer(serializers.ModelSerializer):
    employee_code = serializers.CharField(source="employee.code", read_only=True)
    employee_name = serializers.CharField(source="employee.full_name", read_only=True)
    supplier_payment_code = serializers.CharField(
        source="supplier_payment.code", read_only=True, allow_null=True
    )
    supplier_code = serializers.CharField(
        source="supplier.code", read_only=True, allow_null=True
    )
    supplier_name = serializers.CharField(
        source="supplier.name", read_only=True, allow_null=True
    )

    class Meta:
        model = ExpenseVoucher
        fields = (
            "code",
            "supplier_payment_code",
            "supplier_code",
            "supplier_name",
            "employee_code",
            "employee_name",
            "voucher_date",
            "amount",
            "reason",
            "method",
            "status",
            "note",
        )
        read_only_fields = fields
