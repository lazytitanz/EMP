namespace EMP.UpdateCore;

public class UpdateException : Exception
{
    public UpdateException(string message) : base(message)
    {
    }

    public UpdateException(string message, Exception innerException) : base(message, innerException)
    {
    }
}

public sealed class UpdateRateLimitException : UpdateException
{
    public UpdateRateLimitException(string message) : base(message)
    {
    }
}

public sealed class UpdateNotFoundException : UpdateException
{
    public UpdateNotFoundException(string message) : base(message)
    {
    }
}

public sealed class UpdateVerificationException : UpdateException
{
    public UpdateVerificationException(string message) : base(message)
    {
    }
}

public sealed class UpdatePackageException : UpdateException
{
    public UpdatePackageException(string message) : base(message)
    {
    }
}
